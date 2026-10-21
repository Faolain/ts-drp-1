# Track S: a reopen right after the creator's first maintained lull

**Outcome: fixed.** A room persisted and reopened right after the creator's first maintained lull now reopens,
seals, adopts and plays on, on the node SQLite host, the browser room-database host and the opt-in retention
path, and in the Chromium Grid with the concurrent lull (Track G's failing case). The `floor-stale` resume-basis
check is unchanged. The change is one condition in one function.

- Worktree: `<worktree agent-a2f612353d58c46ea>/`, branch `worktree-agent-a2f612353d58c46ea`, based on
  `codex/phase3a1b-p6-golden-path` at **d7f8c39b** (Tracks M and O merged at 8c61863e). Nothing was pushed.
- Working notes: `<evidence>/track-s/PROGRESS.md`. Logs: `<evidence>/track-s/logs/`. Suite reports:
  `<evidence>/track-s/tests/`. Grid: `<evidence>/track-s/grid/`. Scripts: `<evidence>/track-s/bin/`.
- `CRD` is packages/node/src/internal/creator-closed-rollback-data.ts. `CC` is packages/node/src/creator-close.ts.
  `CRP` is packages/node/src/internal/creator-recovery-pool.ts. Line numbers are at the fix commit (ef57d107);
  the fix removes one line and adds four comment lines inside `classifyClosedSigningSummaries`, so lines after
  CRD:10363 are 3 higher than at base.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).

## Commits

| commit   | kind       | what                                                                                                                                   |
| -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 5a7491f8 | test (RED) | `tests/track-s-first-lull-reopen-native.test.ts` and `tests/fixtures/track-s/first-lull-reopen.ts`: 6 tests, 3 hosts × 2 reopen points |
| ef57d107 | fix        | CRD `classifyClosedSigningSummaries`: a terminal SAME-P signing summary is never replayed, with or without generation pressure         |
| (this)   | docs       | this RESULT.md                                                                                                                         |

## 1. Reproduction (RED, 5a7491f8)

`tests/track-s-first-lull-reopen-native.test.ts`, fixture `tests/fixtures/track-s/first-lull-reopen.ts`.

- **Composition:** Track N's Grid settlement room: the Grid zone application, `creator-trusted-settlement-v1`,
  the creator and one Writer recipient that both issue every epoch, and the scripted native-byte successor
  transport. Each rollover runs Grid's LULL=1 order: one move each, seal (after a 300 ms wait, Track M's
  finding 5), adoption, install, then the creator's and the recipient's pool-maintenance lulls.
- **Hosts** (`gridRoom(host)`):
  - `sqlite`: the node SQLite host (`createNodeV3RoomStorageHost`), as Track N's test;
  - `room`: the browser room-database host on fake-indexeddb, through Track M's `settlementRoom`, with R3's FIFO
    process lock manager (`installEnvironment`);
  - `room-retention`: the same with `roomRetention: true` (Tracks M and O).
- **Reopen points:**
  - "right after the lull": close and reopen both peers right after the creator's first `maintained` lull;
  - "after moves that follow the lull": one more move each at that epoch first.
- **Assertions:** rollovers run until the creator's lull first returns `maintained` (epoch 4 on every host). The
  creator's stored AHE control has no active intent and `completed.throughEpoch` = 3. On `room-retention` the
  retention path declines that boundary with a `*-birth` reason, so the existing path owns it and reaches the same
  state (requirement (c)). After the reopen: the recipient's authority is at the same epoch, both projections
  equal the world before the close, the control has no intent and has not gone backwards. Then 2 rollovers with
  both lulls not deferred, the recipient's authority at epoch 6, one more move each, and the control has advanced.
  Every native owner joins (`closeFixtures()` is empty).

| host           | reopen right after the lull                                                                               | reopen after moves that follow it                                                |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| sqlite         | base: refused at the first seal after the reopen (`TRACK_S_STAGE rollover 4: … floor-stale`); fix: passes | base: refused at the reopen (`TRACK_S_STAGE reopen: … floor-stale`); fix: passes |
| room           | same                                                                                                      | same                                                                             |
| room-retention | same                                                                                                      | same                                                                             |

Base: `<evidence>/track-s/logs/red-base-1.log`, 6 of 6 fail, each at CRD:19360 (base), the `resumeBasisDigest`
check. Fix: `<evidence>/track-s/logs/green-2.log`, 6 of 6 pass (205 s).

The two reopen points match the two symptoms Track Q saw: on the room-database host the reopen succeeded and the
first seal refused; on the node host Track Q's long-room driver admits moves after the lull before the close, so
the reopen's own readiness resume refused.

## 2. Root cause

### 2.1 What the resume basis covers, and where it is checked

A signing-summary decision stores a `SigningSummaryRetirementSource` whose `resumeBasisDigest` is computed in
`installClosedRetirementSource` (CRD:19349-19373):

- `sourceBytes` (CRD:19337-19347): the summary, the floor, the AHE rows, the snapshots, the snapshot image, the
  **journal image**, and (when present) journal prefixes, journal headers and signing details;
- the **issuance rows and image** (CRD:19358);
- the retained (residual) signing rows (CRD:19350-19351, 19359);
- the **journal's canonical rows** (CRD:19360).

On the first install of a decision the stored digest is undefined, and the computed one is stored (CRD:19367-19372).
When a stored summary source is passed back in, the digest is recomputed over the current owners and must be equal,
or the install refuses `floor-stale` (CRD:19362-19363). This is the refusal Track Q found.

### 2.2 Which inputs differ

I instrumented the check (patch kept at `<evidence>/track-s/diag-instrumentation.patch`, never committed) to print
a digest of each input. At the failing replay (`<evidence>/track-s/logs/diag-grid-reopen4-1.log`, Grid probe,
reopen right after the lull, first seal after it):

| input                                                                                         | at the decision (stored) | at the replay |
| --------------------------------------------------------------------------------------------- | ------------------------ | ------------- |
| summary, floor, AHE rows, snapshots, snapshot image, retained signing rows, prefixes, headers | equal                    | equal         |
| journal image                                                                                 | e4dee6c1…                | a97c9b74…     |
| AHE generations (rows)                                                                        | 5                        | 5             |
| journal canonical rows                                                                        | 18 rows                  | 23 rows       |
| issuance rows / image                                                                         | 7 issued                 | 9 issued      |

Only the journal and issuance differ: they now hold the creator's lawful moves at epoch 4, admitted after the lull's
decision. So:

- **The stored digest is right at write time.** The lull's own replays of the same decision recompute the same
  digest (`stored = computed = ee3ca5e0…` in the same log).
- **No in-memory state is a basis input.** Every input is read from a durable owner under the decision's held
  reads. Track Q's lead, the early-turnover token, matters for a different reason (§2.4): it decides whether a
  second reconciliation runs at all, not what that reconciliation hashes.
- **Resume does not use different inputs.** It uses the same owners at a later state. The digest correctly
  reports that the state moved on.

The fault is that a reconciliation **selected the stored, already-completed source again** after lawful writes,
instead of making a fresh decision.

### 2.3 Why the completed summary is selected again

`reconcileSnapshotRecoveryRoles` asks `classifyClosedSigningSummaries` (CRD:22195-22205) for the signing-summary
source. When the signing control's preparation is the same decision as the AHE coordinator's ("SAME-P",
CRD:10289-10293) and has a stored summary source (CRD:10306), the function can:

1. resume a residual summary of the same decision (CRD:10331-10362);
2. hand a **terminal** SAME-P summary, whose drain has finished, to a fresh authenticated selection, after binding
   its exact residual image with `checkClosedSigningSummaryImage` (CRD:10363-10388);
3. otherwise `return stored` (CRD:10389): replay the stored source, which re-runs its basis check.

At base, branch 2 had one more condition (base CRD:10364):

```ts
input.reader.generations.length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 2 &&
```

so a terminal summary was handed off only under AHE generation pressure (more than 5 generations). Without it, the
completed terminal summary fell to branch 3 and was replayed. The replay is a no-op only while the owners are
unchanged since the decision.

The creator's first maintained lull is the first boundary with any retirement work, and it has no generation
pressure (5 generations). Its passes (`<evidence>/track-s/logs/diag-grid-reopen4-3.log`):

| pass               | decision                                                       |
| ------------------ | -------------------------------------------------------------- |
| 1                  | evidence (epochs 0 and 1) and journal prefixes                 |
| 2                  | summary, epoch 0                                               |
| 3                  | residual summary, epoch 1 (the terminal summary)               |
| 4 (terminal probe) | base: replays pass 3's stored summary, `completed-same`, no-op |

So the boundary ends with the completed control's preparation carrying a summary source whose basis covers the
journal and issuance **as they were during the lull**. Every later reconciliation at the same floor replays it.

### 2.4 When a later same-floor reconciliation runs

- **In session, none.** The close of the lulled epoch re-runs reconciliation only if
  `creatorCloseRetirementResumeRequired` says so, or under capacity pressure (CC:3791-3805). At the first maintained
  boundary there is no capacity pressure, and the close finds the control byte-equal to the token the lull
  captured (`captureCreatorEarlyTurnoverToken`, CRP:37-43, CC:4856), so it does not resume (CRP:53-75).
- **After a reopen, two.** The token is process-local (CRP:31-32: "a crash loses it and the close keeps the
  original durable resume rule"):
  1. the reopened creator's readiness boundary resumes a completed control at the current boundary
     (`runCreatorOrdinaryReadinessMaintenance`, packages/node/src/v3-live.ts:11299-11310, Track L) with
     `requireClosedWorkflowCompletion`. It replays the summary. If moves were admitted after the lull and before
     the close, the basis differs and the **reopen** refuses (variant B; Track Q's node host).
  2. the first close after the reopen has no token, so `creatorCloseRetirementResumeRequired` returns true and it
     reconciles again. After the epoch's next moves the basis differs and the **first seal** refuses (variant A;
     Track Q's room-database host and Grid probe).

The in-memory token is therefore what lets an in-session room avoid the replay, and its loss is what exposes the
replay after a reopen. Restoring a token after a reopen would not be sound (it would let an unverified completed
control skip its resume) and would not cover variant B, where the reopen's own resume refuses.

### 2.5 Why a reopen after two or more maintained lulls works

From the second maintained lull on (epoch 5 and later), the creator has 6 to 7 AHE generations, more than
`maxObjectGenerations - 2` = 5:

- branch 2 above applies: the terminal summary is handed to a fresh selection, which selects AHE generation
  reclamation;
- the boundary's last decision is a generation decision, whose preparation has no summary source;
- any later same-floor reconciliation finds no stored summary to replay and makes a fresh decision
  (`<evidence>/track-s/logs/diag-grid-reopen5-3.log`, a fresh classification-only decision at the reopen).

Completed generation sources were already not replayed: `classifyClosedGenerationSource` (CRD:9049-9052) says
"Completed generation custody alone is not a request to replay its historical whole source after the joined
journal ACK or lawful above-frontier writes". Branch 2 states the same rule for a terminal summary, but only under
generation pressure. In every room traced here (Grid on SQLite and on the room database, with and without
retention), the first maintained lull is the only boundary that ends on a terminal summary without generation
pressure.

The same holds without the lull (R3's tests before Track Q): the close of epoch e makes the boundary's decision
inside the close, after all of that epoch's moves, and the next reconciliation is at a new floor, where SAME-P does
not hold. After a reopen the completed control is one boundary behind, so the readiness resume does not apply
(v3-live.ts:11307). The lull moves the decision before the rest of the epoch's moves, which is what makes a
same-floor replay after lawful writes possible.

## 3. Fix (ef57d107)

### 3.1 The change

One file, one function: CRD `classifyClosedSigningSummaries`. The generation-pressure condition is removed from the
terminal SAME-P branch (CRD:10363-10388), and its comment says why:

```diff
 		if (
-			input.reader.generations.length > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 2 &&
 			control.active === null &&
 			input.coordinator?.active === null &&
 			drain != null &&
 			isSigningSummaryRetirementPlan(drain.plan) &&
 			drain.plan.baseControl.completed?.decisionDigest === preparation.decisionDigest &&
 			drain.plan.baseControl.completed.sourceProofDigest === preparation.sourceProofDigest &&
 			drain.cursor === drain.plan.entries.length
 		) {
 			// A terminal SAME-P summary replay is not new maintenance work. Bind
 			// its exact residual rows before allowing the freshly authenticated
 			// whole source to select capacity reclamation, never a count-only grant.
+			// With or without generation pressure: its stored resume basis binds
+			// every owner's state at its decision, which lawful writes since (this
+			// epoch's moves, before or after a reopen) change, so a replay would be
+			// refused floor-stale. Only an unfinished intent or drain is resumed.
 			checkClosedSigningSummaryImage({ … });
 			return undefined;
 		}
 		return stored;
```

A completed summary decision whose drain has finished (no active intent on either control, the drain plan is this
decision's, its cursor is at the end) is no longer replayed. Its exact residual image is still bound by
`checkClosedSigningSummaryImage` (CRD:10994): the drain plan equals the stored source, the remaining signing data
digest matches, the residual rows are exact and every retired entry is absent. Then the function returns
`undefined`, and the same pass makes a fresh, fully authenticated decision over the current owners. At the first
maintained boundary there is nothing left to retire, so that decision is classification-only: it retires nothing
and records the boundary over the current state. That is exactly what already happened at every later boundary,
whose fresh selection found generation work.

Everything that is unfinished is still resumed through `return stored` and still passes the unchanged digest check:
an active signing or AHE intent, a summary decision whose drain has not been planned or has not finished, and a
residual summary of the same decision (branch 1, which runs before this branch and is unchanged).

**Not changed:** the resume-basis computation and its `floor-stale` check (CRD:19349-19363), every classifier and
owner rule, the pass loop and its bound (CC:2425), the early-turnover token and the close's resume rule, the
readiness resume, the retention path. No stored format changes.

**Source-text tests.** No test reads `classifyClosedSigningSummaries` (searched for its name, the condition and the
comment text). No name was added.

### 3.2 What changes at run time

The trace with the fix (`<evidence>/track-s/logs/diag-fix-sqlite-1.log`, sqlite, both variants):

| step                                        | base                                           | fix                                                  |
| ------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| first maintained lull (epoch 4), passes 1-3 | evidence; summary 0; summary 1                 | same                                                 |
| its terminal probe (pass 4)                 | `completed-same` replay of summary 1, no write | `new` classification-only decision                   |
| reopen, readiness resume (variant A)        | replay matches (no moves yet)                  | `completed-same` classification                      |
| reopen, readiness resume (variant B)        | replay, `floor-stale`                          | `new` classification                                 |
| first close after the reopen                | replay, `floor-stale`                          | `new` classification                                 |
| epochs 5 and 6                              | (unreached)                                    | evidence; summary; generation; generation, as before |

The lull's pass count is unchanged (4); the terminal probe pass now writes one classification-only decision (one
two-phase metadata install) instead of a no-op. Without the lull, the same happens inside the close of the first
maintained boundary. From the second maintained boundary on, nothing changes: the branch already applied there.

### 3.3 Guarantee argument

The brief's rule was: make the two digests agree only when the state truly agrees. They do not agree here, because
the state does not: the journal and issuance hold lawful moves made after the decision. So the digest check stays as
it is, and the fix stops asking it a question whose honest answer is "stale". A completed decision is not
re-presented as if it were resumable work; the current state gets a fresh decision of its own.

- **G26, latency never relaxes safety.** No check is removed or weakened, and none is skipped for speed.
  - The `resumeBasisDigest` check (CRD:19362-19363) and the generation basis check (CRD:19383-19384) are unchanged
    and still run for every source that is replayed.
  - The removed condition was not a safety check. It decided which of two existing outcomes a completed terminal
    summary gets: replay (base) or residual-image check plus fresh decision. Both outcomes refuse on any mismatch.
    The second binds the residual image exactly and authenticates the whole current source, which is the stronger
    of the two.
  - A mismatched digest is never accepted: a replayed source with a different basis still refuses `floor-stale`.
- **G3, crash and reopen recovery.** The six RED tests reopen at both points (right after the lull, and after the
  epoch's later moves) on three hosts and then seal, adopt, install, run both lulls for two more epochs, and move.
  Track Q's Canvas and Chat cases and R3's "(4 rollovers)" pass on top (§4.2). A crash during the new
  classification-only install is the existing two-phase install (old XOR new, G15) that every boundary from the
  second maintained lull on already runs.
- **G14, one bounded resumable intent.** Unfinished work still resumes exactly as before through `return stored`:
  an active signing or AHE intent (`control.active`, `coordinator.active`), a summary decision whose drain is not
  planned or not finished, and a same-decision residual summary (branch 1). The hand-off requires the terminal
  state: no intent on either control, the drain plan is this decision's (`baseControl.completed` digests equal),
  and its cursor is at the end. There is still one intent per boundary; nothing new is made resumable.
- **G17, no resurrection / monotone state across reopen.** The tests assert after the reopen that the control has
  no intent, `completed.throughEpoch` has not gone backwards, and both projections equal the world before the
  close; after two more rollovers `throughEpoch` has advanced. The fresh decision is made at the same floor as the
  completed one (`throughEpoch = floor - 1`) and retires nothing, so no fence moves back and nothing deleted comes
  back.
- **G24, the startup floor is never repaired.** No floor, watermark or control is rewritten to make a check pass.
  The fresh decision is an ordinary decision over the authenticated current state; the stored summary source and its
  digest are not edited, recomputed into the store, or trusted in place of a proof.
- **G7, one retirement owner.** Every decision is still `reconcileSnapshotRecoveryRoles` →
  `installClosedRetirementSource`; no sweeper, no new path. A completed label alone still grants nothing: the
  hand-off first re-binds the residual image, and the fresh decision re-authenticates.
- **G10, only immutable syntax and signed facts outlive a stage.** The stored resume basis is the currency of the
  stage that made the decision. Replaying it later, at a new state, was reusing that currency; the fix makes the later
  stage pay for its own decision, as `classifyClosedGenerationSource` already does for completed generation custody
  (CRD:9049-9052).
- **G9 and G15, transactional recheck and crash atomicity.** At the first maintained boundary the fresh decision is
  classification-only: no deletion, no participant fence. Its install is the existing two-phase metadata install.
- **G18, protected set.** Unchanged: the classification-only decision retires nothing, and the residual check
  requires the earlier retirements to still be exactly absent.
- **G21 and G22, bounded work and proof budget.** The pass bound (`2 + signing epochs + generations`, CC:2425) is
  unchanged and the lull's pass count is unchanged (4 at the first maintained boundary). The stored source's bytes
  are still charged before the hand-off (CRD:10329-10330), and the fresh decision pays its own charges in the same
  pass. No refund, no reuse of a paid proof.
- **G5, durable bytes are carriers.** The stored summary source is read from the store; before it may hand off,
  `checkClosedSigningSummaryImage` checks it against the drain plan and the current rows, and the fresh decision
  authenticates the current source from scratch.
- **G23, lull ingress.** Unchanged. Moves arriving during the lull still queue and are admitted after it.
- **G28, native evidence.** Node SQLite and fake-indexeddb at node level, and real IndexedDB in Chromium for the
  Grid (§5). No new SIGKILL case was added: the new step at the first boundary is the existing classification-only
  install, already covered wherever a boundary ends on one.

### 3.4 Alternatives considered and rejected

- **Accept the replay when only the journal and issuance moved on.** That relaxes the digest check (G26) and would
  bind a decision to a state it was not made over.
- **Leave the journal and issuance out of the summary's resume basis.** A format and law change to an authenticated
  digest, and the basis must cover them while the summary's drain is unfinished.
- **Re-capture the early-turnover token after a reopen.** The token is process-local by design: it vouches only for
  a control this process's own turnover produced. Inventing one at reopen would let a completed control skip its
  resume. It also would not cover the reopen's own readiness resume (variant B).
- **Keep the decision's inputs in memory, or replay against stored historical images.** Memory is lost at a crash,
  and historical images are exactly what retirement removes.

## 4. Evidence

### 4.1 RED tests

| run                            | result                                               | log                                      |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------- |
| base d7f8c39b + RED (5a7491f8) | 6 of 6 fail, `floor-stale` at the resume-basis check | `<evidence>/track-s/logs/red-base-1.log` |
| fix ef57d107                   | 6 of 6 pass, 205 s                                   | `<evidence>/track-s/logs/green-2.log`    |

### 4.2 Track Q on top

On a scratch branch `track-s-scratch-q-on-s` (local only, never merged or pushed; Track Q's branch untouched), Track
Q's four commits were cherry-picked onto ef57d107 without conflicts (9c0cffaa, 0bc1aae5, ef13154a, c47400a7 →
a4b75ccd, f3219450, 68f9478d, c2c5b93c).

| test                                                                                                                                                | Track Q alone (base c67c66b7)                                                                          | Track Q on Track S                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| tests/room-database-retirement-native.test.ts (R3)                                                                                                  | "(4 rollovers)" fails `floor-stale` (`<evidence>/track-q/logs/rdr-head-1.log`)                         | 4 of 4 pass, including "(4 rollovers)" and "(5 rollovers)" (`<evidence>/track-s/logs/q-on-s-r3-1.log`) |
| tests/canvas-chat-creator-lull-native.test.ts                                                                                                       | 2 of 2 pass                                                                                            | 2 of 2 pass (`q-on-s-lull-1.log`)                                                                      |
| tests/canvas-chat-resource-bound.test.ts                                                                                                            | 13 of 13 pass                                                                                          | 13 of 13 pass (`q-on-s-bound-1.log`)                                                                   |
| tests/canvas-chat-long-room.test.ts, `CANVAS_CHAT_LULL=1`, reopen after epoch 4, 8 epochs, node and room hosts, both recipient modes, shipped bound | Canvas node: refused at "reopen epoch=4", `floor-stale` (`<evidence>/track-q/logs/reopen4-node-1.log`) | 8 of 8 pass, Canvas and Chat (`q-on-s-reopen4-1.log`)                                                  |

Track Q's long-room driver admits moves that arrive during the creator's lull after the lull, and then reopens; that
is the "after moves that follow the lull" case. Its reopen checks that both states equal the state before the close
and the recipient's authority is at the same epoch, then plays the remaining epochs.

### 4.3 Room tests (Tracks K, L, R3, N, M, O and S)

`<evidence>/track-s/bin/suite.sh <label> rooms`: tests/recipient-_-native.test.ts (4 files),
tests/room-database-retirement-native.test.ts, tests/track-m-_.test.ts (8 files), tests/track-o-\*.test.ts (3 files)
and the Track S test. Reports: `<evidence>/track-s/tests/{base,head}-rooms.json`, comparison
`<evidence>/track-s/tests/compare-rooms.txt`.

|                        | total | passed | failed                  | skipped (env-gated, same in both) |
| ---------------------- | ----- | ------ | ----------------------- | --------------------------------- |
| base (fix swapped out) | 164   | 91     | 6 (the six Track S RED) | 67                                |
| head                   | 164   | 97     | 0                       | 67                                |

Per test: 6 fixed (the Track S RED), 0 new failures. The skipped tests are Track M's opt-in long rooms
(`track-m-apps-creator-issue-profile`, `track-m-canvas-long-room`, `track-m-chat-long-room`) and Track O's
env-selected split points; they are skipped identically at base.

### 4.4 Suites against base

Base is this branch with the fix swapped out of the working tree (`<evidence>/track-s/bin/swap.py base`): its product
code is byte-identical to d7f8c39b (`git diff d7f8c39b -- packages` empty), and the node dist was built from it.
Head is ef57d107 with the node and storage-node dist rebuilt. Same scripts, same file lists as Tracks M, N and O.
Comparison is per test (`<evidence>/track-s/bin/compare.py`; `<evidence>/track-s/tests/compare-*.txt`).

| set                                               | base: total / passed / failed / skipped | head                  | per test                             |
| ------------------------------------------------- | --------------------------------------- | --------------------- | ------------------------------------ |
| node (packages/node)                              | 1071 / 1023 / 48 / 0                    | 1071 / 1023 / 48 / 0  | identical                            |
| of which creator-closed-rollback-proof-accounting | 351 / 331 / 20                          | 351 / 331 / 20        | identical (Track O also recorded 20) |
| storage-node retirement (6 files)                 | 209 / 158 / 49 / 2                      | 209 / 158 / 49 / 2    | identical (Track O: 49)              |
| root room set (Track N's 93 files)                | 1038 / 677 / 337 / 24                   | 1038 / 677 / 337 / 24 | identical                            |
| rooms (§4.3)                                      | 164 / 91 / 6 / 67                       | 164 / 97 / 0 / 67     | 6 fixed, 0 new                       |

The brief expected 21 known failures in the proof-accounting file; both runs here and Track O's record 20, the same
20 in base and head. The base root run and room run were at load averages of 120 to 200 (other tracks running);
nothing timed out differently between base and head.

**Typecheck:** `pnpm -r typecheck` exit 0, 0 errors (`<evidence>/track-s/logs/typecheck-1.log`). Prettier: the two
new files pass `prettier --check`. Shadowed-source guard: `node scripts/check-shadowed-sources.mjs` exit 0.

## 5. Grid (Chromium, real IndexedDB)

Bundles from `<evidence>/track-s/bin/bundleonly.sh` (the dist packages the bundle reads, canonical, storage,
protocol-v3, compaction and storage-browser, are unchanged from d7f8c39b and were built from it): `grid/s-head-1`
at ef57d107 and `grid/s-base-1` with the fix swapped out. Their `entry.mjs` files differ only in the fix's line and
one generated instrumentation label. Runs: `<evidence>/track-s/bin/grid.sh`, the README's healthy native Grid
recipe ("healthy native Grid integrates gameplay warm rollover cleanup persisted reopen and continuation").

**The brief's run: LULL=1, 8 rollovers, head** (`grid/run-lull1-1`): passed in 158 s at load average about 100: 8
transitions, the persisted reopen and continued gameplay. The creator's lull is `deferred:unsupported` at epochs 1
and 2, `not-needed` at 3 and `maintained` from 4 to 8; every recipient lull from 3 is `maintained`.

**Reopen right after the creator's first maintained lull** (4 rollovers; the Grid reopens after the last lull):

| run                                       | lull                      | host          | base                                                                                                     | fix           |
| ----------------------------------------- | ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| base4-1 / head4-1                         | `1`                       | default       | passes                                                                                                   | passes        |
| base4-room-1 / head4-room-1               | `1`                       | room database | passes                                                                                                   | passes        |
| base4-conc-1 / head4-conc-1, head4-conc-2 | `concurrent`              | default       | **fails**: `{"phase":"persisted-reopen", … "creator snapshot role reconciliation refused: floor-stale"}` | passes, twice |
| base4-conc-room-1 / head4-conc-room-1     | `concurrent`              | room database | **fails**, same phase and refusal                                                                        | passes        |
| head8-conc-1                              | `concurrent`, 8 rollovers | default       | (not run)                                                                                                | passes        |

- With `LULL=1` the Grid admits no move between the creator's lull and the close, and its continuation after the
  reopen issues one move but does not seal (tests/fixtures/startup-discovery/r8-source-binding.ts, "inherited-
  continuation"). Neither refusal point is reached, so base passes; variant A's refusal needs a seal after the
  reopen, which the node tests provide.
- With `LULL=concurrent` moves are issued while the creator's lull runs and are admitted after it, before the close.
  This is variant B, and it is the failure Track G recorded (Track G README, line 154). Base refuses at the reopen,
  on both hosts. The fix passes.

**Cost of the fix.** The extra classification-only decision at the first maintained boundary:

- In the lull (4 rollovers, LULL=1, single runs at load 20 to 35): the `pool-maintenance-lull` phase at t4 is
  2385 → 2448 ms on the default host and 2196 → 2231 ms on the room database (+35 to +63 ms). The lull is off the
  critical path; moves that arrive during it queue (G23).
- Without the lull (LULL=0, 5 rollovers, the seal of t4 runs the boundary inline), two ABBA pairs:

  | pair | order     | base seal t4 | fix seal t4 |
  | ---- | --------- | ------------ | ----------- |
  | 1    | base, fix | 2504 ms      | 2521 ms     |
  | 2    | fix, base | 2569 ms      | 2730 ms     |

  +17 and +161 ms (1 to 6 %). The same runs' t0 to t3 seals, which the fix does not touch, differ by up to 100 ms
  between runs, so this is within noise; at most it is one metadata install at one boundary per room.

- From the second maintained boundary on, nothing changes: the branch already applied there.

## 6. What remains, and risks

- **Track Q can rebase onto this branch.** Its four commits apply without conflicts, and R3's "(4 rollovers)" passes
  with them (§4.2). Track Q's branch was not touched.
- **Parallel tracks.** The change is one condition inside `classifyClosedSigningSummaries`, which neither Track P
  (issuance retention, `creatorFilteredIssuanceStore` in v3-live.ts) nor Track M2 (the opt-in retention path's
  verified-fact ledger) is expected to edit. The retention path reaches this classifier only through the existing
  path, which owns the first maintained boundary (`*-birth` decline).
- **Risk: one extra metadata decision.** The first maintained boundary of every room now ends with a fresh
  classification-only decision instead of a no-op replay: one more two-phase metadata install, in the lull (off the
  critical path) or, without the lull, inside that boundary's seal. Measured within noise (§5). Later boundaries are
  unchanged.
- **Risk: a different first-boundary shape in other applications.** Any composition whose boundary ends on a
  terminal summary without generation pressure now gets the fresh decision. That is the behaviour every boundary
  under pressure already had, and the Grid, Canvas and Chat cases (node and Chromium) pass. A boundary that still has
  retirement work after the summary gets that work selected, as it already did under pressure.
- **Not covered:** no new SIGKILL case for a crash inside the new classification-only install at the first boundary
  (it is the existing install, covered where boundaries already end on one); no Firefox or WebKit Grid run.
- **Unchanged and out of scope:** the early-turnover token stays process-local, so the first close after any reopen
  still re-runs one reconciliation (now a fresh decision rather than a refusal). Track Q's note that the first seal
  after a reopen runs one inline retirement selection still holds.

## Files and functions touched

- packages/node/src/internal/creator-closed-rollback-data.ts: `classifyClosedSigningSummaries` only (one condition
  removed, four comment lines added). No name added; no test reads this function's source text.
- tests/track-s-first-lull-reopen-native.test.ts (new).
- tests/fixtures/track-s/first-lull-reopen.ts (new): `sqliteSettlementRoom` (module-local), and exported
  `gridRoom`, `lullRollover`, `playOneMoveEach`, `creatorRetirementControl`. It reuses Track M's `settlementRoom`,
  `settlementTransition` and `settlementDelivery` and Track M's room-retention fixture helpers unchanged.
- docs/realtime-latency/tracks/29-track-s-first-lull-reopen/RESULT.md (this file).

No existing test, governance test, frozen artifact, registry or vector was edited. docs/realtime-latency/README.md
was not edited.
