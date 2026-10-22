# Track Z: the room database by default for new rooms

**Outcome:** Merged as a fast-forward to bdad8de1 (8e2156fc..bdad8de1, on 0171994d; row 70). A new browser room created with no storage host lives in one version-7 room database with retention, and the library runs the recovery-pool lull once per epoch: the creator's after its adoption, every recipient's after its install. Existing rooms open on the host they were created on; Node and explicit hosts are unchanged. On the shipped pages over real networking, seal falls from about 3 s to 266-296 ms and install from about 1.7 s to 266-308 ms; adoption is unchanged. This is a new-room default, not continuous-play correctness: harnesses still pause play during rollovers (row 60). See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [MAP.md](MAP.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-21 18:56 UTC)

You are Track Z in a multi-track latency and storage effort on ts-drp, a TypeScript local-first CRDT library for real-time games. Your full brief is at <evidence>/track-z/BRIEF.md. Read all of it first and follow it exactly, including its hard rules (especially the Node PATH pin and the shared-port check) and its hand-back point at step 1.

Your base is codex/phase3a1b-p6-golden-path at 24d4ca61. It includes Track X's real-network delivery fix and Track Y's cache changes.

In short: the shipped Canvas, Chat and Grid pages run on the default six-database storage host. With real networking their creator seal takes 3–9 s, and the bench's default mode gives about 3.4 s. The opt-in fast path (the room database with retention and the creator lull) seals in about 0.26 s in the bench. The owner chose to make the room database with retention the default for new rooms, while existing rooms keep their host, with no migration.

Step 1 is measurement only: attribute the shipped pages' seal, adoption and install by phase, and show what opting them into the fast path buys on real networking. Then stop and send the coordinator a short report. You will be resumed with SendMessage.

Keep <evidence>/track-z/PROGRESS.md current (<evidence> is the scratchpad path given in the brief), so you can resume after any interruption.

### Report returned by the agent (2026-10-21 22:19 UTC)

Track Z, step 1 (measurement) is done; I'm stopping here for your go-ahead on steps 2-7. The full answer is at the top of <evidence>/track-z/PROGRESS.md (<evidence> = <evidence>).

**Answer: the flip alone does not reach the bench's opt-in figures; the flip plus a lull does.** Real networking, Chromium, 16 epochs, 2 runs per arm. Figures are medians over epochs 5-16 on a loaded machine (load 20-270), in ms.

| Page | Shipped (seal / adopt / install) | Flip only | Flip + explicit lull | Shipped host + explicit lull (1 run) |
|---|---|---|---|---|
| Canvas | 2654 / 733 / 1442 | 758 / 730 / 367 | 254 / 746 / 206 (lulls 396 / 151) | 240 / 699 / 181 (lulls 2530 / 1065) |
| Chat | 3125 / 776 / 1606 | 870 / 988 / 443 | 298 / 876 / 226 (lulls 435 / 167) | 234 / 708 / 182 (lulls 2588 / 1103) |
| Grid (legacy profile) | 3104 / 440 / 1912 | 736 / 424 / 491 | 281 / 465 / 264 (lulls 457 / 222) | 231 / 388 / 224 (lulls 2564 / 1122) |

The lull is what brings seal and install to the bench. The room database with retention is what makes the lull cheap: on the shipped host each lull costs 2.5 s on the creator and 1.1 s on the recipient, every epoch. Without a lull, the flip still cuts the seal fallback from 2.7-3.1 s to 0.74-0.87 s.

**Where the time goes:**
- **Seal:** inline retirement is 2.4-2.9 s of the shipped seal (4 selections per epoch, because no page runs a lull). With the flip it becomes one retention pass of 0.42-0.56 s. What's left is about 0.25 s in every arm.
- **Install:** the received recovery turnover runs inline, 1.2-1.6 s on the shipped host and 0.14-0.22 s with the flip. A recipient lull removes it.
- **Adoption:** the host and the lull leave it unchanged. It is settlement publish (0.28-0.38 s, Canvas and Chat only) plus the readiness capture (0.22-0.34 s) plus about 0.13 s. Canvas and Chat end up 0.05-0.2 s over the bench's 0.64-0.69 s. With a lull, the creator also captures readiness a second time inside the lull.

**What else stands in the way:**
1. **The automatic lull (1 s idle) almost never fires under continuous play.** It ran in 1 of 32 creator epochs on Canvas, 2 of 32 on Chat and 0 of 32 on Grid, so the seal stays at 0.67-0.80 s. With a 3 s pause after each install, it ran every epoch and the seal reached 0.22-0.23 s.
2. **Receive-only recipients never get the automatic lull.** The Canvas and Chat observers keep the inline turnover, so install stays at 0.34-0.44 s against about 0.2 s with a recipient lull.
3. **Every room's first retirement round costs 2.1-2.8 s, once.** Retention declines the room's earliest epochs (reasons ahe-birth, journal-same-epoch, signing-same-epoch) and the per-class path runs instead. That cost lands in the first lull or, without one, in the epoch-5 seal. When the automatic lull picked it up during play, the next move waited 2.2 s.
4. **The known seal deadlock (Track X §9)** hung 2 of 36 runs at harness epoch 3. One was on the shipped host, so the flip does not cause it. Neither hang print recorded the step; I added that afterwards.
5. **Grid's legacy profile still grows by 4 rows per epoch on every host.** Canvas and Chat storage stays flat.

**Commits** (measurement-only harness options, on worktree-agent-a869e104e72e01ff1; the worktree is on it and clean):
- c1fb0210: per-window phase probe, explicit lull and page globals.
- c17c68b0: rollover deadline for the Grid harness.
- a2bd48c8: hang prints carry the hung step and recent spans.
- 377633cf: retention decline reasons counted.

The temporary node instrumentation (track-z-measure, 74204426) and the example opt-in (track-z-optin, 9ca99e21) are scratch branches that must never be merged. The node dist is rebuilt clean.

**Housekeeping:**
- No processes from my runs are left.
- Startup races with Track X's back-to-back runs were retried automatically.
- I did not measure Grid with Track V's settlement switch (15bf2ed1).
- The bench inputs are not copied yet; they're only needed from step 5.

Data:
- Per-run and per-phase results: <evidence>/track-z/data/compare-all.txt
- Run logs: <evidence>/track-z/logs/

### Follow-up instruction — Owner's go-ahead for Track Z steps 2-7 with lull scope (2026-10-21 23:13 UTC)

Thank you for the step-1 attribution. The owner has decided the flip's scope. Go ahead with steps 2-7 of your brief, with these additions:

1. THE LULL IS PART OF THE DEFAULT (owner's choice). On the new default (room database with retention), the library schedules the lull every epoch instead of relying on the 1 s idle trigger: the creator's lull after its adoption, and every recipient's lull after its install, including receive-only recipients. Rooms on the six-database host keep today's behaviour, with no new scheduling (a 2.5 s lull per epoch there would block play). Put it in the library, not the examples. Argue in MAP.md where the scheduling lives and how it interacts with the idle scheduler, recoveryPoolAutoMaintenance and an app's explicit lull calls; there must be no double lull.
2. Add RED tests for the scheduling: on a default new room, the creator and each recipient (Writer and receive-only) run exactly one lull per epoch with no idle time; a six-database room runs none it didn't run before.
3. MEASURE WHAT PLAY SEES DURING THE SCHEDULED LULL. Report, as p50/p90/max, the creator's admission of a peer move during its lull and a recipient's own issue during its lull, per app, against the flip without the lull. If a move during the lull waits much longer than the lull's own figures suggest, stop and report.
4. OUT OF SCOPE, as separate tracks later (owner's choice): the one-off 2.1-2.8 s first retirement round (a follow-up track after your flip lands), and adoption (a track after Track X's startup fix merges). Record both in RESULT.md as what remains, with your decline-reason counts.

Base: main has moved to ebf4254f. It now has Track W's Chat window (examples/chat only) and Track X's seal deadlock fix (creator-close.ts close(): the stage now happens before the sources), which should remove the epoch-3 hangs you saw. Start step 2 from it: `git switch -C worktree-agent-a869e104e72e01ff1 codex/phase3a1b-p6-golden-path`, then cherry-pick your four harness commits (c1fb0210, c17c68b0, a2bd48c8, 377633cf). Rebuild every dist, since your node dist was built from track-z-measure.

Parallel work: Track X is changing the settlement creator's startup order (v3-room.ts rebasePromise) and adding a readiness ingress hold (prepareCreatorOrdinaryReadiness in creator-close.ts, a new creatorCloseRegistration method and enqueueV3Ingress in v3-live.ts). Don't edit those functions. If the lull scheduling has to hook near them (for example after install in v3-room.ts), keep the edit separate and minimal, list it, and report the overlap before making it. Track V's Grid switch merges after Track X; measure Grid as it is on main.

Everything else in the brief stands: never edit RED or governance tests, frozen artifacts, registries or vectors (list class (ii) amendments for the owner); the Node PATH pin; per-port checks including 4174, 50000 and 50002; RESULT.md into folder 36; hand back with the final report.

### Report returned by the agent

Track Z needs an owner decision on 14c: wiring it as the spec says would make every room fail closed on reopen.

Status: rebased on ebf4254f with the 4 harness commits cherry-picked (now bfb42d68, 8d7d9d14, 21b88495, c395e2b3). Dists rebuilt. MAP.md in progress. I am carrying on with the parts that don't depend on 14c: host selection, the default, and the lull scheduling.

THE COUNTEREXAMPLE

1. On the retention host, the first retirement of every room runs the existing per-class path, not retention.
   - Retention declines while any owner control is unborn: CRD:21195-21206, decline `control-birth`, plus `ahe-birth`, `*-same-epoch`.
   - The existing path is what creates and advances the five owner controls (installClosedRetirementSourceInRoom, CRD:19193).
   - Step 1 saw this on every page.
   - Any later decline also runs the existing path: unit-over-cap above about 85 signers, `floor-fence-unavailable`, or any RETENTION_* refusal.
2. 14c's open check (14c "Check at every open") allows only three states per owner: control == target, control == base, or "no entry" for 14d migration copies. "Anything else" must fail closed with RETENTION_FENCE_MISMATCH and is never repaired.
3. The existing path writes no per-owner fence. So any control it advances, before the first fence or after one, fails closed at the next open. There is no migration, so "no entry" never applies.
   - The next fenceRetirement would also refuse with ROOM_HEAD_FENCE_CONFLICT, because base no longer equals old.target. Retention would then never run again.

A SECOND FINDING: 14c is inert on every floor we run. The shipped pages take their floor from the app host (window.__TS_DRP_*_ROOM_HEAD_AUTHORITY_FOR_OPEN__). In every harness that floor is the Node SQLite floor over RPC (tests/fixtures/phase-3a1b/grid-room-head-authority.ts), and so is the bench. The SQLite floor has fenceDecision but no fenceRetirement, and 14c puts the SQLite floor out of scope. The library cannot turn on `retirementFences: true` for a floor the host supplies; it can only use the fences when the floor offers them.

OPTIONS

- (a) FULL WIRING, my recommendation if 14c must land before the flip. It is not the smallest change, and it adds most of the risk.
  - The node uses per-owner fences only when the floor offers fenceRetirement and readRetirementFences. Otherwise behaviour stays as today.
  - It fences every owner-control change on the room host:
    - retention decisions: step A before the room transaction commits;
    - existing-path room-session stages: read the five control digests in the held transaction and fence the changed owners before each checkpoint and commit. This needs a new session read in storage-browser;
    - per-owner control transactions on the room host (inherited classification): these need fencing too.
  - Open check: a new room has no migration copies, so "no entry" is consistent until that owner's first fence. After that, control must equal base or target, or the room fails closed.
  - This needs a class (ii) note: the 14c text says "no entry: migration copies only".
  - Tests run on fake-indexeddb with a browser IDB floor that has `retirementFences: true`. The three-engine 14c RED #2 does not exist yet.
- (b) PARTIAL: fence only the retention decisions, and scope the open check to owners whose last control change was a fenced decision. This cannot tell an existing-path advance from tampering, so it is weaker than the spec. I don't recommend it.
- (c) DEFER 14c and flip without it. What protects the room today is Track M's step A, fenceDecision (one floor transaction of decision labels), and trust RED 4: a mark claiming more retirement than the floor fails closed at open. What 14c would add is detecting a room database that lost retirement, or was changed behind the floor, at per-owner granularity. That only matters with an IndexedDB floor, which no shipped host uses today. Record 14c as remaining.

Which do you and the owner want? Until you answer I will not touch CRD.

Also, as asked, the v3-room.ts edits I plan for the scheduled lull, all outside Track X's functions:
- adoptCreatorSuccessor (6680): at the end of the non-redirect transition body, after performCreatorSuccessorAdoption() resolves, call a new scheduleEpochLull() that enqueues one lifetime transition. performCreatorSuccessorAdoption is not edited.
- installCreatorSuccessor (6838): the same call at the end of the transition body, after requestMissingRetainedHistory(). Exact-repeat installs return early and schedule nothing.
- session.maintainRecoveryPool (7452): factor its body into a local runRecoveryPoolMaintenance(trigger) so the scheduled lull runs the identical path. The public contract is unchanged.
- The auto-scheduler start block (7581): pass a new `settled(epoch)` hook, so the idle scheduler skips epochs the scheduled lull settled.
- packages/node/src/internal/recovery-pool-auto.ts: the optional `settled` hook in tick().
- Gate: the captured host's `roomRetention === true`. Six-database rooms get nothing new.

Overlap with Track X: none of rebasePromise, prepareCreatorOrdinaryReadiness, creatorCloseRegistration or enqueueV3Ingress is touched, and creator-close.ts is not touched. The lull still awaits rebasePromise and migrationCompletionBarrier exactly as maintainRecoveryPool does today. A textual merge conflict is possible only if Track X edits adoptCreatorSuccessor or installCreatorSuccessor.

### Report returned by the agent

Track Z needs a second owner decision: the flip will break about 13 class (ii) RED tests, and spec 14 forbids flipping while any new per-test failure exists.

THE PINS (read-only inventory; full table goes in MAP.md)

Node RED tests that build default-host rooms through examples/v3-room and mock the six-database factories (`packages/storage-browser/dist/src/{index,issuance,live-journal}.js`), with no IndexedDB:
- phase-3a1b-d9346-room-semantics-red:279-310 (I checked this one)
- phase-3g-v3-room-rebase-red
- phase-3h-v3-room-rehearsal-red
- phase-6b-d110c-0c1f5b0c-room-red
- 0c1f5b0u-room-runtime-red
- 0c1f5b0u-successor-replay-red

Fixture-based tests that open six-database names after a default room:
- grid-snapshot-content-delivery-room-red
- the phase-6b grid REDs, via tests/fixtures/grid-room-workload.ts
- recovery-retention-red.pw, via the phase-6a product entry; phase-6a-creator-successor-product-red:130 requires that entry's text to keep `--ahe` dumps
- bounded-active-read-red.pw
- startup-discovery browser-red.pw:664 (the only database must be the floor)
- track-x-seal-source-deadlock-red: its "six-database" case is "no storageHost", so it would silently test the room host

Other affected tests:
- d9346-v3-room-extraction-red:143 pins the room package's runtime exports. It already fails; any new export widens the gap.

Specs:
- specs/bounded-storage-lifecycle/slices/14-single-database-watermark-retirement.md:107-118 says the default may flip only "in a separate final commit, after 14f passes on three engines with no new per-test failures; otherwise it stays opt-in".
- requirements-to-evidence.md:376 says "The default host is unchanged".
- The 14a-14f status lines say opt-in.

The amendment for almost every pin is the same: pass an explicit six-database host. That needs the binding to export one, for example `createBrowserV3SixDatabaseStorageHost()`.

OPTIONS

- (1) Owner amends first: the owner, or a track allowed to edit (ii) tests, adds the explicit host to those tests. My flip then lands as the separate final commit with no new failures.
- (2) I flip as the last commit and report the (ii) failures with exact amendments. This contradicts 14:107-118 as written, so the owner would have to amend that rule too.
- (3) Option (2), plus a binding rule: with no `indexedDB` global, keep the base six-database default. This keeps the six mock-based node REDs green, since they never touch IndexedDB. The browser and fake-indexeddb pins still fail. It is a real rule (no IndexedDB means no routing probe), but it exists mostly for those tests.

My plan, unless you say otherwise:
- Build everything on my branch.
- Put the flip of the default in its own final commit (examples/v3-room only).
- Run the suites with and without that commit, so the owner sees exactly which (ii) tests fail and why.
- Do (3) only if you ask.

THE LULL GATE (no decision needed)
- To keep Track M, M2, O and S's (ii) tests and the bench's explicit opt-in unchanged, the scheduled lull is a node option (`recoveryPoolScheduledLull`). The binding turns it on only together with the room host it selects by default.
- An explicit `roomRetention` host gets no scheduling unless it asks. Otherwise track-m2-ledger-red:106-118 would fail: the explicit lull there must return `maintained` with a ledger pass.

The 14c question from my previous message is still open.

### Follow-up instruction — Owner: defer 14c; approve explicit-host pin amendments (2026-10-21 23:50 UTC)

The owner has decided both questions.

1. 14c: DEFER (your option c). Flip without 14c. Don't touch CRD for 14c. In RESULT.md and MAP.md, record:
   - the counterexample: the existing path writes no per-owner fence, so the 14c open check fails closed on every room after its first retirement;
   - the second finding: every floor we run is the Node SQLite floor over RPC, which has no fenceRetirement, so 14c is inert there;
   - what protects rooms today (Track M's step A fenceDecision, and trust RED 4);
   - what full wiring would need (your option a, including the 14c text amendment, the new storage-browser session read and the three-engine RED #2).
   14c stays a remaining item, to revisit if an IndexedDB floor ships.

2. PINS: the owner approves option (1), the explicit host.
   - Export an explicit six-database host from the binding (for example `createBrowserV3SixDatabaseStorageHost()`).
   - Amend each listed class (ii) test only to pass that explicit host where it relied on the default, and add the new export to the d9346-v3-room-extraction-red:143 export pin. track-x-seal-source-deadlock-red's "six-database" case gets the explicit host too.
   - No other change to any of those tests: no assertion, value or expectation changes. If a test needs anything beyond the explicit host to keep testing what it tests today, stop and report it.
   - Put the amendments in their own commit before the flip, with a message naming the owner's approval and listing every file and line.
   - The flip of the default is then the separate final commit (examples/v3-room only, as you planned), and with the amendments in place there must be no new per-test failures, as spec 14:107-118 requires.
   - In the flip commit, update the spec status lines that say opt-in or "the default host is unchanged" (14a-14f status lines, requirements-to-evidence.md:376) to describe the new default. List each one in RESULT.md.
   - Don't do option (3).

Your v3-room.ts plan for the scheduled lull (adoptCreatorSuccessor 6680 and installCreatorSuccessor 6838 tail calls, the runRecoveryPoolMaintenance refactor at 7452, the settled hook at 7581 and in recovery-pool-auto.ts, gated on the captured host's roomRetention) is fine. So is the gate design (`recoveryPoolScheduledLull`, turned on only with the default room host it selects). Track X's pending branch edits rebasePromise, readiness and enqueueV3Ingress, not those two transition bodies. Note in MAP.md where a textual conflict could arise.

Carry on. Run the suites with and without the final flip commit, as you planned.

### Follow-up instruction — Heads-up: moves during seal/adopt fail the creator's adopt (2026-10-22 00:15 UTC)

Heads-up from Track X, a bug that predates both your work and Track X's. If a Writer moves during the creator's seal or adoption, the creator's next adoption fails at epoch 1. Seen on the node host, at main's source too ("active replacement source custody refused: portable source protected dependency is unavailable", from drainSettlementOutbox → issueSettlement). Every shipped harness pauses moves during rollovers, which is why nothing has hit it. Track X fixes it next, after its startup work merges. For your proofs, keep the harnesses' pause during seal/adoption. The moves you measure during the scheduled lull (after adoption or install) are fine. If you see that refusal anywhere, record it as this known issue and don't investigate it.

### Follow-up instruction — Correction: the Writer's install fails, not the creator's adopt (2026-10-22 00:16 UTC)

Correction to my heads-up. In the seal-time case it is the Writer's install that fails, not the creator's adoption. The Writer's own move made during the creator's seal is outside the cut. Its install must rebase that move into the new epoch, and the portable replacement's dependency walk (v3-live 6782) refuses, so the Writer goes terminal; the creator survives. Same handling: keep the rollover pause in your proofs, and if you see it, record it as this known issue without investigating.

### Follow-up instruction — Main moved: Track X's startup order and hold merged (2026-10-22 03:29 UTC)

Main has moved to 30cb474e. It now includes Track X's startup order and readiness ingress hold (merge 8595826c), which change packages/node/src/v3-room.ts (rebasePromise on v1, the startup publication order), v3-live.ts (enqueueV3Ingress's hold and a creatorCloseRegistration hold method) and creator-close.ts (prepareCreatorOrdinaryReadiness). Before your final proofs and suite comparison, merge or rebase onto it. Keep your amendments commit and the flip as the last two commits, and compare suites against 30cb474e. Your adoptCreatorSuccessor and installCreatorSuccessor tail calls shouldn't conflict textually, but check that the scheduled lull still waits for the readiness hold to release (the lull's maintenance must not run while a readiness job holds ingress). Add a test if that interaction can be reached. Track X's next work (play during a rollover, in the settlement drain and the portable replacement) avoids your v3-room spots.

### Report returned by the agent (2026-10-22 05:45 UTC)

Track Z: the bench at the new default found a second bug that the scheduled lull makes common. I plan a minimal fix in v3-room republishRetainedHistory, which sits next to Track X's startup republication barrier, so I am reporting the overlap before I edit.

1. Where things stand. The first close bug is fixed (fd1b1e09, with RED a012f33e: a recipient lull running at close asked the revoked transport for retained history). After that fix, the healthy native Grid bench in default mode at the final head passes 2 of 5 runs. The base default passes 3 of 3, and opt-in mode passes 4 of 4 at head. All 5 head runs complete their 8 rollovers.

2. The new failure. The 3 failing runs fail at the persisted close with "original transport operations failed: v3 room retained publication failed: publication-state-unknown" (or "not-active").

3. What causes it. A recipient's scheduled lull ends "maintained" right after its install, and then asks every peer for retained history. This request is pre-existing: it repairs arrivals that the bounded input pool refused. A peer that is installing (or adopting) at that moment serves the request from its old plane. Its successor activation replaces the plane registration mid-send, so v3-live returns publication-state-unknown or not-active. v3-room's republishRetainedHistory throws for this outside an orderly close. f9828cd0 made exactly that exception for close, with the same three result kinds.
   - The shipped transport (room-network.ts:431/435/795/799) ignores publisher rejections, so the shipped apps lose nothing.
   - The bench's strict worker transport counts every rejection as an operation failure.
   - Nothing that peer needs is lost: its old-epoch rows are in the successor's cut, or are rebased.
   - Explicit lulls never hit this in the bench, because the harness runs them after all installs.

4. Planned fix (new RED first, then a separate fix commit, both before the amendments and the flip). In republishRetainedHistory (v3-room.ts:4160-4180), the publication captures its plane. A not-active or publication-state-unknown result, with no terminal failure, returns instead of throwing when the session has moved past that plane: `activeHandle !== plane`, or a creator adoption or recipient install in flight (`creatorSuccessorAdoptionTask !== undefined`).
   - Store and record faults still reject, as does publish-failed on a current plane.
   - Overlap: Track X's setRetainedPublisher wrapper with startupGossipRepublicationBarrier is directly below (:4181-4192). I do not touch it, rebasePromise, readiness or enqueueV3Ingress. A textual conflict is possible only if Track X edits republishRetainedHistory itself.

I will go ahead unless you tell me otherwise; the RED comes first, so there is time to stop me.

### Follow-up instruction — Approve republishRetainedHistory fix with conditions (2026-10-22 05:45 UTC)

Go ahead with the republishRetainedHistory fix, RED first and the fix as its own commit before the amendments and the flip. Conditions:
1. Before you edit, check the source-text pins: tests/fixtures/phase-6b-d110c-b/source-shape.mjs and any other test that reads v3-room.ts text. If one covers lines 4160-4192, stop and report it instead.
2. Keep the exception as narrow as you describe. A not-active or publication-state-unknown result returns only when the session has moved past the captured plane, or an adoption or install is in flight, and there is no terminal failure. publish-failed on a current plane, and store and record faults, still reject. Add a test for each of those that still rejects, beside the RED.
3. In RESULT, argue why the requester loses nothing (the rows are in the successor's cut or rebased), and say whether the requester ever retries the repair if the answer is dropped.
4. Proof after the fix: the bench in default mode at head, at least 5 of 5, and in the explicit opt-in mode, unchanged.
I'm telling Track X about the overlap. It is currently adding a gate on the successor material server (serving only after adoption), plus an R5 fix in the journal retirement classes. Neither should touch republishRetainedHistory.

### Follow-up instruction — Main moved to 0171994d with Track W2 (2026-10-22 06:22 UTC)

FYI: main (codex/phase3a1b-p6-golden-path) is now 0171994d, with Track W2 merged. It doesn't touch the library: it adds examples/chat (a v5 format, an admin grant control and index.ts changes), tests and docs. Before your final proofs, rebase onto 0171994d. Shipped Chat now creates v5 rooms, so the flip also changes the host they open on. Add these to your proof set: tests/track-w2-shipped-chat-membership.pw.ts (playwright.track-w2-chat-membership.config.ts, port 4181), W2's unit files (tests/track-w2-departed-admission, -chat-shares-rule, -chat-shares-room), and the shipped Chat page in Track X's harness at the new default. Say whether any W2 test needs the explicit six-database host. If one does, that is a new amendment for the owner: list it, don't edit it.

### Report returned by the agent (2026-10-22 08:12 UTC)

Track Z final report (steps 2-7). Brand-new browser rooms now default to the room database with retention, and the library runs the lull once per epoch on them. The branch is rebased onto 0171994d (Track W2). The amendments and the flip are the last two commits. No new per-test failure against base, and `pnpm -r typecheck` reports 0 errors.

**Where things are**
- Worktree: <worktree agent-a869e104e72e01ff1>/
- Branch: worktree-agent-a869e104e72e01ff1, HEAD bdad8de1. Nothing pushed. Status is clean apart from the untracked bench inputs under .logs, which are not committed.
- RESULT: <worktree agent-a869e104e72e01ff1>/docs/realtime-latency/tracks/36-track-z-room-database-default/RESULT.md (committed; prettier run; local paths written as `<evidence>/...`)
- Map: <evidence>/track-z/MAP.md
- Progress log: <evidence>/track-z/PROGRESS.md (current)

**1. Commits on 0171994d, in order**
- Measurement-only harness: 8e2156fc, a3a36360, 5e9666fa, d38a973e
- 13ce5c3f: RED for the default, the routing and the scheduled lull
- 1e9558ae: node, opt-in `recoveryPoolScheduledLull`
- e8a5c3d6: binding, a room opens on the host it was created on
- 9e54c01a, 38b4611c: harness, lull windows and Writer-first Grid
- f6c1b41f: binding exports `createBrowserV3SixDatabaseStorageHost()`
- 97c75635: docs, the lull doc and the G23 citation
- 8ec357a2: test, the lull never overlaps Track X's readiness hold
- 4cdc057c: close RED
- eb693ca4: close fix
- d94bdb4c: retained-publication RED
- 45e0ea52: retained-publication fix
- 84551a16: RESULT.md, plus G23's citation moved to v3-room.ts:564-581
- **8957cf68**: owner-approved amendments (last commit but one)
- **bdad8de1**: the flip (last commit)

Supporting checks:
- `git diff 1c7ee87b bdad8de1` shows only RESULT.md and golden-path-guarantees.md. So every proof run at 1c7ee87b (tree head5) holds for bdad8de1.
- `git diff 2a00d915 1c7ee87b` is exactly W2's 24 files. My stack shares no file with W2.
- Backup branches: track-z-stack-1 to track-z-stack-7.
- I fixed one formatting slip before the final commit: prettier had turned `__vite_ssr_import_8__` in a §12 table into bold, so I put it in backticks. Every other table row was checked against its source.

**2. Step 1's attribution (unchanged)**
- The room host with retention alone cuts the seal from 2.7-3.1 s to 0.74-0.87 s.
- The lull is what moves seal and install down to the bench's figures. Retention makes the lull affordable: 0.40 s against 2.5 s per epoch on six databases.
- The idle lull almost never fires in continuous play: in 1, 2 and 0 of 32 creator epochs on Canvas, Chat and Grid.
- Adoption is unchanged. The first retirement round costs 2.1-2.8 s once per room.

**3. The map and the pins**
- **Prerequisites:** 14a, 14b and 14f were done on the opt-in path. 14d (migration) is not needed, because existing rooms are routed to their own host. 14e is unchanged.
- **14c, deferred by the owner:**
  - The counterexample: the existing per-class path writes no per-owner fence, so the 14c open check would fail closed on every room after its first retirement.
  - It is inert on every floor we run: the Node SQLite floor over RPC has no fenceRetirement.
  - What protects rooms today: Track M's step A `fenceDecision` and trust RED 4.
  - Full wiring is option (a), including the 14c text amendment, a new storage-browser session read and the three-engine RED #2.
- **Pins:** owner's option (1). 13 class (ii) files pass only the explicit six-database host. RESULT §5.5 and the 8957cf68 message list every file and line.
  - The d9346 extraction pin gains the export at :144. It still fails, as at base, because of two exports that predate this track.
  - Track X's seal-source "six-database" case passes the explicit host.
  - No test needed more than the explicit host.
- **Spec status lines** updated in the flip commit:
  - 14-single-database-watermark-retirement.md: a new Status section
  - 14a:8-11
  - 14b:5-7
  - 14c:7-11
  - 14d:7-10
  - 14e:5-7
  - 14f:7-11
  - requirements-to-evidence.md:376
- **Overlap with Track X:** none of rebasePromise, prepareCreatorOrdinaryReadiness, creatorCloseRegistration, enqueueV3Ingress or creator-close.ts is touched.
  - Possible textual-conflict hunks in v3-room.ts:
    - :6753-6763 (adoptCreatorSuccessor)
    - :6838-6842 (the close guard)
    - :7046 (the install tail)
    - :7096 (promote)
    - :7529-7557 (maintainRecoveryPool)
    - :7673 (the idle scheduler)
    - :564-581 (the input option)
    - :2452 (validation)
    - :4325-4333 (scheduledLulls construction)
    - :4161-4186 (republishRetainedHistory, just above Track X's untouched wrapper at :4188)

**4. The flip, and why each part is safe**
- **Where the default lives:** examples/v3-room/src/index.ts, the only place a browser room gets a host when the app passes none. Every shipped app and the bench go through it. packages/node keeps `storageHost` required, and Node hosts are unchanged (a RED guards this).
- **Host selection:** `existingRoomLayout` (index.ts:214-230) reads database names without creating any.
  - A version-7 main database selects the room host.
  - Any six-database name selects the six-database host, unchanged.
  - Otherwise `NEW_ROOM_LAYOUT = "room"`: the room host with retention and `recoveryPoolScheduledLull` (an app may pass false).
  - A wrong choice can only fail to open; it never modifies a room. Existing rooms keep their host and code (G25).
  - Shown in a real browser: a room created at base reopens at head with the same six databases and versions, the same state, and no lull.
- **The scheduled lull:** library code in v3-room.ts, with bookkeeping in internal/recovery-pool-scheduled.ts.
  - It runs in the lifecycle FIFO right after a creator adoption or promotion and after every recipient install, receive-only included.
  - There is never a double lull:
    - at most one schedule per epoch;
    - an explicit call in a settled epoch returns the settled result;
    - the idle scheduler skips a settled epoch through a new `settled` hook;
    - the seal's inline maintenance remains the backstop.
  - It never runs while Track X's readiness hold is in place. The hold exists only inside a transition, and the lull runs after that transition returns. Test 8ec357a2 pins this over 4 epochs.
- Six-database, explicit and Node hosts get no scheduling (RED). G23 holds: moves queue FIFO, none are dropped.

**5. Latency per phase per app** (real networking, Chromium, steady medians epochs 5-16, new default (arm F) against the shipped default (S-2) at comparable load)

| App | Seal (ms) | Install (ms) |
| --- | --- | --- |
| Canvas | 2974 → 296 | 1695 → 284 |
| Chat | 3233 → 266 | 1774 → 266 |
| Grid | 2798 → 278 | 1722 → 308 |

- Adoption is unchanged (out of scope).
- Against the flip without the lull, the lull cuts the seal 2.9-4.8x and the install 1.5-1.9x.
- Steady lull time: creator 0.62-0.70 s, recipient 0.24-0.34 s at low load.
- Shipped v5 Chat after the rebase (Track X's harness): seal 2694 → 260 ms, install 1507 → 236 ms, adoption 723 → 824 ms (within spread). All 4 runs completed 16/16 epochs.

**6. Play during the scheduled lull (addition 3)**
A move waits only for the lull's remainder; after the lull ends, an admission takes 6-17 ms at p50 (158 ms at most). So the stop condition was not met. Steady figures, p50/p90/max in ms, during the lull against the no-lull arm:

| Figure | During the lull | No lull |
| --- | --- | --- |
| Grid creator admitting a Writer move | 242/495/575 | 37/113/337 |
| Grid Writer's own issue | 237/453/507 | 28/36/40 |
| Canvas creator issue | 474/922/1037 | 418/608/822 |
| Canvas recipient admission | 494/944/1061 | 440/638/871 |
| Chat creator issue | 695/1265/1628 | 548/1454/2694 |
| Chat recipient admission | 698/1236/1665 | 556/1480/2839 |

- Maxima of 3.0-4.8 s happen only during the first retirement round.

**7. Bench and storage**
- **Bench, default mode at the final code: 6 of 6 pass** (base 3/3).
  - Seal 1282 → 240 ms, install 1009 → 421 ms, adoption 495 → 453 ms.
  - Exactly 32 scheduled lulls per run (one per role per epoch).
  - Opt-in mode is unchanged: within 6%, 2 of 2 on each side.
  - The rebased bench bundle is byte-identical to the final code's.
  - Cost: reopen takes 0.83 s against 0.27 s on six databases. Opt-in takes 0.78-0.81 s, so the cost is the room host's open path, not this track's code.
- **Storage over 100 epochs** (Canvas, Chat v4 and Chat v5):
  - One lull per role per epoch (200 events).
  - Retention applied on 193 of 200 role-epochs; the 5 declines are the first round.
  - Rows flat: Canvas 129/94, Chat 135/129, v5 135/129.
  - Heap matches Track Y's head to within 0.41 MB; v5 is within 0.06 MB of v4.

**8. 14f per engine**
- z4 at the final code: Chromium, Firefox and WebKit each 9 pass, 1 skip (the skip is case 11 in whole-file runs). Case 11 passes; cases 1-4 give 18 passed.
- z5 at the rebased flip has the same 344 inputs and the same digest 07451ef9…b75a; Chromium 9 pass, 1 skip.

**9. Suites and typecheck** (per test, final code against base)
- **0 new failures** in every set:
  - node: +11 passing
  - storage-browser: its 5 base timeouts now pass
  - storage-node
  - canonical, protocol-v3 and storage
  - the startup-discovery observers
  - the 149-file root set, pooled: 16 base timeouts now pass
  - Canvas and Chat e2e: 9/9
  - d9346: 2/2
- One root test fails only when the suite runs in one shared pool: d110c-0c1f5b0a, from module initialization order in protocol-v3. It fails the same way without the flip and passes alone.
- The flip commit alone adds no failure.
- `pnpm -r typecheck`: 0 errors over 46 projects, at the final code and at the rebased flip. `node scripts/check-shadowed-sources.mjs` exits 0.

**10. Two pre-existing faults the bench found, fixed before the flip, each with a RED**
- **(1) Close (eb693ca4).** A recipient lull still running at close asked the revoked transport for retained history. The request now also requires `!closed`.
- **(2) Retained publication (45e0ea52).** A peer's own adoption or install made a retained publication reject with publication-state-unknown or not-active. Your conditions are met:
  - No source-text pin covers lines 4160-4192.
  - The exception is narrow: it applies only to those two results, with no terminal failure, and only when the session has moved past the captured plane or an adoption or install is in flight.
  - Everything else still rejects, each with a test: publish-failed on a current plane, not-active with no successor, store and record faults, and any result after a terminal failure.
  - The requester loses nothing: the rows are in the successor's cut or are rebased.
  - The requester never saw the rejection. The shipped transport ignores it and retries on its own (7 sends over 15 s, plus at most one missing-history request per second).
  - Bench: 6/6 default, opt-in unchanged.

**11. Rebase onto 0171994d (W2)**
- Shipped Chat's new v5 rooms get the new default.
- W2 Playwright test (port 4181): base 1/1, head 2/2. Seal median 2396 → 252/208 ms.
- W2's 24 unit and room tests pass at both.
- The `vitest related` set has 0 new failures. Its 45 base failures are environment inputs and are identical at both.
- The revoked member's epoch-6 install stall happens at base and head alike; it is W2's revoke path.
- **No W2 test needs the explicit six-database host, so there is no new amendment.**

**12. What remains**
- Out of scope by the owner's choice:
  - **The first retirement round:** 2.7-5.4 s in the creator's epoch-5 lull. Declines per room: creator `ahe-birth` 1, `journal-same-epoch` 1, `signing-same-epoch` 2; recipient `ahe-birth` 1.
  - **Adoption.**
- Recorded by this track:
  - 14c is deferred.
  - Existing rooms stay on six databases (needs 14d to change).
  - The 512-write cap: above about 85 signers, that boundary takes the per-class path.
  - The known Writer-install refusal never appeared in any run.
  - Pre-existing failures are unchanged.
  - Reopen takes 0.83 s against 0.27 s.
  - A granted Writer on the shipped Chat page is covered by the W2 test, the bench, the Grid and Track M.

**13. Risks**
- Moves wait for the lull's remainder: 52-241 ms at p50 in steady play, at most 1.7 s, and several seconds once per room.
- A not-active result for a disconnected target is now silent if it lands during the session's own transition.
- The figures depend on load; every comparison is paired.
- Routing reads database names; a wrong choice only fails to open.
- Track X's next work could conflict textually in the hunks listed in section 3.
- A lull queued at close fails fast with "v3 room session is closed".

No run left processes behind, and every port is free. The commit trailer uses the brief's exact line, as all earlier commits do.
