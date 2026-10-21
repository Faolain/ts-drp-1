# Track X: the settlement fence delivery stall

**Outcome:** Fix merged in cf6d306f (4122ab83..e26cd812, without the startup-readiness RED). A recipient now asks the creator again for a missing dependency, so the settlement fence that arrives before install is no longer lost; shipped Canvas and Chat and the Grid with Track V's switch run 16/16 with real networking. IN PROGRESS: the IndexedDB seal deadlock (row 49) and the startup order (row 45). See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-21 02:21 UTC)

Your brief is in <evidence>/track-x/BRIEF.md. Read it in full before doing anything and follow it exactly. It holds the whole task, the order of work, the hard rules and the report formats.

Track X fixes a delivery stall on the creator-trusted-settlement-v1 profile. With real networking in Chromium, the creator's settlement fence arrives at a Writer before the Writer installs the successor. After a few successors, the creator's moves stop reaching the Writer entirely.

First check that your worktree is at 5ed93b67; the brief says what to do if it isn't. Step 1 comes first and is urgent: find out whether shipped Canvas and shipped Chat on main stall the same way with real networking. Write the answer at the top of <evidence>/track-x/PROGRESS.md. Commit your harnesses, then STOP and hand back a short report. The coordinator will resume you for the root cause and the fix. Keep PROGRESS.md current throughout, so the work can resume if you are interrupted.

### Report returned by the agent (2026-10-21 02:46 UTC)

Track X, step 1: yes, both apps are broken on main. Shipped Canvas and shipped Chat on main (5ed93b67) each stall at epoch 5, on the creator's first move, with Track V's Grid signature. Canvas at b2c3d8f1 (legacy profile) passes 16/16 in both runs. As the brief says, I stopped after step 1.

| App | Commit | Profile | Run | Epochs passed | Stuck at |
|---|---|---|---|---|---|
| Canvas | 5ed93b67 | settlement | c1, p2 (probe) | 4, 4 | epoch 5, creator's 1st move |
| Chat | 5ed93b67 | settlement | c1, p2 (probe) | 4, 4 | epoch 5, creator's 1st move |
| Canvas | b2c3d8f1 | legacy | c1, c2 | 16/16, 16/16 | - |

**Signature** (from the recipient's console in all 4 main runs):
- **Every epoch:** the recipient logs `::v3-ingress not-authenticated` while the creator adopts (the fence arrives before install). It logs `::v3-ingress graph-rejected` at the creator's first move of the next epoch.
- **Epochs 2-4:** that first move shows on the recipient 1.9-3.9 s after issue. Other moves take 4-130 ms. That timing fits the retained-history requests scheduled at install.
- **Legacy:** every move shows in 7-140 ms, and the recipient logs no ingress warnings.
- **Epoch 5:** the first move arrives (a 4th `graph-rejected`) and is never admitted. A later creator move also arrives, logs one more `graph-rejected`, and is not admitted within 20 s. So later moves arrive and are held. Track V's Grid probe saw no ingress line for its later move; here there is one.
- **Timing:** the stall tracks the epoch count, not the clock. The stuck move went out at 20.7-28.4 s of page time (Canvas 28.4 and 20.7 s, Chat 23.4 and 21.6 s), so Track V's 33-41 s comes from the Grid's slower epochs. In every run, on both profiles, the 4th install is the first slow one (0.9-2.3 s, against 0.13-0.29 s before).

**Caveats for your revert decision:**
- **No Writer in the shipped pages:** both pages open every joiner receive-only, and neither can enroll a Writer. So the recipient here is an observer, which means the stall does not depend on the recipient's own issuance.
- **No rollover in the UI:** neither page seals, adopts or installs by itself. The stall appears once a host rolls the room over.

**Harness:** committed as 2aff65f7 on worktree-agent-a9ab847b594d95e7f. It is measurement only and touches nothing in examples/ or packages/.
- Files: `tests/track-x-shipped-app-long-room.pw.ts` and `playwright.track-x-shipped-app-long-room.config.ts`.
- Network: same servers and environment as `playwright.canvas-chat.config.ts`, real libp2p through 2 relays, with an independent account floor per peer as in Track V.
- Each epoch: the creator makes 2 moves through the UI, the harness waits up to 60 s for each to show on the recipient, then the creator seals, exports and adopts and the recipient installs.
- Room handle: the pages expose none, so the harness appends `globalThis.__TRACK_X_ROOM__ = () => room` to the served `/src/index.ts` with page.route. The page code is otherwise unchanged.

**Housekeeping:**
- **b2c3d8f1 run:** made on a scratch branch, `track-x-scratch-b2c3d8f1`, which has no commits and still exists. After it I switched back and rebuilt the protocol-v3 and node dist at main.
- **Dist rebuilds:** the example pages read `@ts-drp/node` from dist, so every node change needs a rebuild before a Chromium run.
- **Cleanup:** no processes were left behind. Ports 4175/4180/4181/51000/51002 are free.

**Two first pointers for step 2, not yet investigated:**
- `packages/node/src/v3-live.ts`: `authenticateV3Ingress` (7864-7929) holds a dependency-missing vertex in `retainPendingIngress` (7390-7411). It drops a not-authenticated vertex (7908-7910), so an early fence is lost, not held. `drainPendingIngress` (7413-7435) runs only after a later successful admission.
- `packages/node/src/room-network.ts:16`: `RETAINED_REQUEST_DELAYS` is a fixed schedule set at install.

Files are in <evidence>/track-x:
- PROGRESS.md (answer at the top)
- logs/canvas-main-c1.log
- logs/canvas-main-p2.log
- logs/chat-main-c1.log
- logs/chat-main-p2.log
- logs/canvas-b2c3-c1.log
- logs/canvas-b2c3-c2.log
- bin/pwx.sh (runner)
- bin/summarize.mjs (summary script)

Failure traces are in the matching `logs/*-results` folders.

### Follow-up instruction — Resume Track X: root cause and fix, plus bisect (2026-10-21 02:47 UTC)

Thanks, step 1 is clear. Please continue with steps 2-8 of your brief: root cause, a RED test, the library fix, proof, Track V's d9346 findings, suites and RESULT.md.

The coordinator is deciding with the owner whether to switch Canvas on main back to the legacy profile meanwhile. Don't act on that. Keep fixing on your branch against main 5ed93b67 (main has since moved to 6b9e27cc with Track Q merged; rebase onto it when convenient). Q changes only Canvas/Chat resource bounds, so the creator lull now runs for both apps. Check that your harness still reproduces with Q in.

One addition to step 2. Shipped Chat has signed `creator-trusted-settlement-v1` since before this latency work began, so find out whether its stall predates that work:
- Run your Chat harness at 8c14a5a2^ or, if that doesn't build or run, at the parent of 4c4f192c (the first commit of this effort).
- If Chat stalls there too, the bug is older than this work. Say so.
- If it doesn't, bisect between that commit and 5ed93b67 to find the commit that introduced it. Use your Chat harness, 6 epochs, and at least 2 runs per step, since the machine is loaded.
- Report the first bad commit and what it changed.
Rebuild the node dist at every step, as you noted. Write the bisect log into <evidence>/track-x/logs/.

Your two pointers look right to start from:
- `authenticateV3Ingress` drops a not-authenticated vertex instead of holding it;
- `drainPendingIngress` runs only after a later successful admission;
- the retained-request schedule is fixed at install.
Also explain why the 4th install is the first slow one (0.9-2.3 s) in every run on both profiles. Recipient turnover begins around there, and the stall comes right after it. And explain why the latency bench, which runs the settlement profile with real networking and passes 100 rollovers, does not stall.

The same hard rules apply: authentication is never skipped, anything held is bounded and counted (G21, G22), and nothing in examples/ changes.

### Follow-up instruction — Correction: bisect from 3c5bb123 (2026-10-21 02:47 UTC)

Correction to my last message: "8c14a5a2" is not a valid commit, so ignore it. The Chat baseline is 3c5bb123, the parent of 4c4f192c ("perf: cut transition and per-move latency for real-time play", the first commit of this effort). Run your Chat harness there first. If Chat doesn't stall there, bisect between 3c5bb123 and 5ed93b67. Everything else in that message stands.

### Follow-up instruction — Resume Track X after the usage-limit pause (2026-10-21 04:31 UTC)

Resume Track X: you were stopped at 00:09 for a usage limit, and it's safe to continue now.

1. CHECK YOUR WORKTREE FIRST. You were stopped in the middle of "swap in the base sources, build, restore the fix", so your fix may currently be swapped out of the working tree.
   - Run `git status`, `git diff` and `git log -3`.
   - Restore your fix exactly as your swap script would. Confirm the working tree matches your intended state before building anything.
   - Rebuild the node dist (and protocol-v3, if you swapped it), since a build may have been interrupted halfway.
2. Read <evidence>/track-x/PROGRESS.md (<evidence> = <evidence>).
3. Any Chromium, bisect or test run that was in flight was killed. Rerun it rather than using partial output. For the Chat bisect from 3c5bb123, rerun the interrupted step. Don't kill processes you didn't start; if leftover workers or dev servers from your own killed runs still hold ports 4175/4180/4181/51000/51002, record that in PROGRESS.md.
4. Continue steps 2-8 of your brief: root cause, the Chat bisect, a RED test, the library fix, proof, Track V's d9346 findings, suites and RESULT.md.

Main is now 725f291b (Track Q is in at 46eb7821, plus docs). The owner chose to keep Canvas on the settlement profile and fix forward, so your fix is what clears the known stall on main.

### Report returned by the agent

Track X is finished. The settlement stall is fixed in the library. With the fix, every Chromium run of Grid (with Track V's switch), Canvas and Chat gets through 16 of 16 epochs. Across all the suites, comparing each test with base, nothing new fails.

Resume check: the worktree was clean and still matched the fix commit. No base swap was in progress when the usage limit hit, and the pause-variant runs had already finished, so their logs are complete. No processes or ports of mine were left behind. I rebased onto main 725f291b (a docs-only change) and rebuilt the node dist.

**Commits** (branch worktree-agent-a9ab847b594d95e7f, on 725f291b, not pushed):
- 4122ab83 test: the Canvas/Chat Chromium harness
- 7cbbcaef test: RED for the settlement fence that reaches a recipient before its install
- d48b57cd test: RED for a lost creator move that the creator's next move needs
- 24699ced fix: a recipient asks the creator again for a dependency it is missing
- 3e806aff test: RED for the census refusing a migrated Writer's plan
- f4c3c5c2 fix: the issuance census accepts a migrated Writer's inherited plan
- f2d301d5 docs: docs/realtime-latency/tracks/34-track-x-settlement-fence-delivery/RESULT.md

Scratch branches left in place: track-x-grid-switch (the fix plus Track V's 15bf2ed1, for the Grid proof only) and track-x-scratch-b2c3d8f1 (no commits).

**Step 1 answer:** yes, shipped Canvas and shipped Chat on main stall at epoch 5, in every run, with Track V's signature. They still stall with Track Q merged. Legacy Canvas passes 16/16. Chat already stalls at 3c5bb123 (2 of 2 runs), so the bug is older than the latency work and no bisect was needed.

**Root cause:**
- Creator adoption publishes the settlement author fence by gossip (v3-room.ts:6663). It reaches the recipient while the recipient is still on the old epoch.
- `authenticateV3Ingress` (v3-live.ts:7909) fails it as not-authenticated and drops it; it is never held.
- Install asked for nothing, and copies arriving during the install hit the closing plane and were dropped.
- The creator's next move is held in pending ingress, waiting for the fence. Nothing asks for the fence, and `drainPendingIngress` only runs after a later successful admission.
- The only repair was the retained-request schedule each session starts at open: 0, 0.5, 1.5, 3, 6, 10 and 15 s after open (room-network.ts:16).
  - In the trace, the creator's +6, +10 and +15 s republishes repaired epochs 2, 3 and 4.
  - Epoch 5's first move came after the last one and was never repaired.
  - The stall follows the number of ticks, not the clock. That is why it is always epoch 5, why a 5 s pause moves it to epoch 4, and why it shows at 20–28 s of page time on Canvas/Chat and 33–41 s on Grid.
- Every later creator move depends on that fence, so it stays held until the pending bounds fill. It is lost, not delayed.
- The 4th install is the first slow one because it is the recipient's first received recovery turnover (`receivedRecoveryTurnoverDue`, creator-adoption.ts:885). Legacy does the same. It comes just before the stall but does not cause it; with the fix it is still slow and nothing stalls.
- The bench doesn't stall because it does not use the room network (it uses the worker transport). After every rollover it also runs `synchronizeRetainedHistory` on all roles (healthy-grid.ts:553/224), which fetches the dropped fence every time. The shipped pages have no such step.

**The fix and why it is safe:**
- What it does: when a recipient holds a fully authenticated vertex whose dependency is missing, it asks the creator for retained history. That is one request at once plus at most one more a second later, routed through the existing coalesced request, with one timer per room that is cleared at close. A recipient also asks once after each successful install. The creator never asks anyone.
- What it touches:
  - room-network.ts: `#requestMissing`, `requestMissingRetainedHistory`, `close`
  - v3-live.ts: `bindV3MissingDependencyRequest`, `requestMissingDependencies`, `authenticateV3Ingress`
  - v3-room.ts: the optional `V3RoomTransport.requestMissingRetainedHistory`, a session helper, `revokeTransport`, the ingress setup, `installCreatorSuccessor`
- Authentication (G5): never skipped. The answer re-enters `authenticateV3Ingress` from the start, and the request only fires after a vertex has passed authentication.
- Bounds (G21, G22): nothing new is held. Pending ingress keeps its existing bounds and census counts, and requests are capped at one a second per room.
- No late callbacks (G4, G17): the timer is cleared at close, the binding is removed when the transport is revoked, and the plane only calls while it is current.
- G23: answers use the same FIFO ingress queue.
- G26, G27: nothing in examples/ changed.
- Ablation: the on-demand trigger is the necessary part. With only the install-time request, the second RED fails.

**Chromium results** (node dist rebuilt with the fix before each run):

| App | Runs | Epochs | Recipient ingress per epoch |
|---|---|---|---|
| Grid, Track V's harness with the switch | g1, g2, g3, 5 s pause | 16/16 each | 1 not-authenticated, 0 graph-rejected |
| Canvas | c1, c2, 5 s pause | 16/16 each | same |
| Chat | c1, c2, 5 s pause | 16/16 each | same |

- The creator's first move of each epoch now reaches the recipient in 6–203 ms. Before the fix it took 1.9–3.9 s, then never arrived.
- Storage is flat from epoch 7: Grid 169/13 and 148/13, Canvas/Chat 160/13 and 111/0 (rows/issued).
- From epoch 5 on, the creator's seal takes 3–9 s on all three apps. That is its settlement maintenance; base never got that far, so there is no browser comparison, and the fix touches no seal path.
- Latency bench, 8 rollovers, 4 interleaved base/fix pairs, all pass. Pooled medians base vs fix: seal 3481/3412 ms, adoption 685/695, install 2237/1971, issue 54.7/51.7, delivery 120/118. Unchanged.

**d9346 findings** (with Track V's switch):
- **Line 908** ("issuance retirement plan has no lineage") was a library defect, now fixed in f4c3c5c2.
  - The migrated joiner's target issuance database held a settlement plan with one inherited entry, no fence and no lineage yet.
  - The room writes that plan itself before its first target fence, and the store accepts it. But `issuanceRetirementImage` (retirement.ts:1426) only accepted a plan with no lineage when every entry names an external source in `sourceObjectId`, so it refused the inherited entry and the joiner could never open the zone.
  - The fix also accepts inherited entries under the same conditions, and only when they come into this object from another one. The RED pins that a plan with a local source, a fence, no entries, or an inheritance into another object is still refused.
  - The migration test now passes 3/3.
- **Line 474** is not a placement defect, but it needs your decision with the owner. I changed nothing and did not edit the test.
  - The build inside the placement window is the creator's startup readiness preparation; the placement's own issue takes the warm path.
  - On settlement the startup barrier (`rebasePromise`, v3-room.ts:5705) publishes accepted rows before it prepares readiness, and publishing waits for a subscriber on the topic (network/node.ts:2819-2822). So readiness can't finish until the first peer joins.
  - The first placement soon after the join waits for it, up to about 1.5 s here. With a 3 s wait before the placement, the whole test passes.
  - Options: accept the cost and amend the assertion (needs owner approval); change the library's startup order so readiness doesn't wait for a subscriber; or leave it.
- Once in 6 migration runs, the reopened joiner's "rejoined" block didn't reach the creator. The joiner logged direct-stream send timeouts and the creator logged nothing at all, so this looks like a link failure. I did not investigate it.

**Suites, per test, base vs fix** (base = the same tree with the 4 library files at 725f291b and dist rebuilt):

| Set | Result |
|---|---|
| node | 1023/1071 on both sides |
| snr | 163/226 on both sides |
| native6 | 35/50 on both sides |
| obs | 23/23 |
| grid | 65/65 |
| root (123 files) | 0 new failures; 8 fixed, all of them Track X tests |
| Canvas/Chat e2e | 9/9 on both sides |

The base failures are the same tests on both sides, all pre-existing. `pnpm -r typecheck` has 0 errors (46 of 47 projects), and `node scripts/check-shadowed-sources.mjs` is clean.

**What remains, and risks:**
- Creator-side gaps are not re-requested, since the creator asks no one. I saw no such case.
- Recipients ask only the creator, as the existing request already did.
- There is no periodic retry. If an answer is lost and the creator sends nothing new, the held move waits for the creator's next move or the next install.
- Requests are bounded at one a second per room plus one per install.
- The bench doesn't exercise the new path, because its transport lacks the method.
- Track V's Grid switch is still unmerged; I only used it on the scratch branch.

Everything is under <evidence>/track-x/. PROGRESS.md there is current, logs/ has the Chromium, RED, d9346 and bisect logs, tests/ has the suite reports, and bench/ has the bench runs.

### Follow-up instruction — Owner chose: fix the startup order (2026-10-21 13:33 UTC)

Coordinator here. Thanks; your report is in hand. I'm verifying your branch (f2d301d5) for merge into main on a scratch branch. Don't rebase or rewrite those commits; add new work on top of them on your branch.

The owner's decision on d9346 line 474 (2026-10-21): FIX THE STARTUP ORDER in the library. On the settlement profile, the creator's startup readiness preparation must not wait for a subscriber. Then the first placement after a join takes the warm path, and the d9346 test passes with its assertion unchanged.

Please do this:
1. Root cause, with citations: the startup barrier (`rebasePromise`, v3-room.ts:5705) publishes accepted rows before it prepares readiness, and publishing waits for a subscriber on the topic (network/node.ts:2819-2822). Say why that order exists, and what depends on publish happening first: delivery, a census, an invariant, or a test that pins the order.
2. RED test first, at node level if possible: a settlement creator with no subscriber completes its readiness preparation promptly, and the first placement after a join takes the warm path (no finishing resource program inside the placement). Commit it before the fix.
3. The smallest library fix that keeps G1-G28. Do not drop or defer any publish that delivery needs; a publish may wait for a subscriber, but readiness must not wait for it. If the fix needs a design or spec decision, stop and report the options.
4. Proof:
   - the RED test green;
   - d9346 with ALL FOUR of Track V's held commits on a scratch branch (d5a0015f, 15bf2ed1, 5b55b6e9, 27fe2688, from worktree-agent-a84dc20beddb97044; note that `expectProductInput` gains a profileId parameter), unchanged and passing, over at least 3 runs, including the migration case;
   - Track V's Grid harness with all four commits, 16/16;
   - your Canvas and Chat harnesses, 16/16;
   - the latency bench at 8 rollovers, paired against your current head;
   - per-test suite diffs against your current head, typecheck and the shadow guard.
   That scratch branch is the integration check for merging Track V's switch after you. Report any conflicts or fixes it needs.
5. If time allows, look at the 1-in-6 migration run where the reopened joiner's "rejoined" block didn't reach the creator. Say whether the cause is the link or something in the library.
6. Add a section to your RESULT.md and keep PROGRESS.md current.

Parallel work:
- Track Y is changing cache ceilings in packages/canonical, packages/protocol-v3 (index.ts, internal/ed25519-verify.ts), packages/storage/src/values.ts and packages/node/src/internal/creator-transition-advance.ts. Don't edit those.
- Track W owns examples/chat.
- A default-flip track (room database by default) will start soon, after your current commits merge, and may touch host selection.

Hard rules are as in your brief. Final report: the commits, the root cause, the fix and its safety, d9346 and the Chromium results with all four V commits, the bench, and the suite diff.

### Follow-up instruction — Verification: Canvas run hung at epoch 3 (2026-10-21 14:30 UTC)

Coordinator here. Something from verifying your branch, to look at FIRST, before you continue the startup-order work.

My merge of f2d301d5 onto main 760607d9 (scratch branch verify-track-x in another worktree) gave:
- typecheck 0 and the shadow guard clean;
- your three RED files pass, along with every room and Canvas/Chat test I ran;
- Canvas/Chat e2e 9/9;
- your Chat harness 16/16, and Track V's Grid harness with 15bf2ed1 16/16;
- Grid bench at 4 rollovers, LULL=1 and concurrent with the room database and retention, both pass.

BUT: your Canvas harness (tests/track-x-shipped-app-long-room.pw.ts -g "shipped canvas page") hung once.
- Epochs 1 and 2 were normal: seal 106 and 65 ms, adoption about 450 ms, install 150–180 ms, delivery about 110 ms.
- Then the creator's rollover evaluate in epoch 3 never returned (sealEpoch/export/adopt, line 340), and the test hit its 30-minute timeout.
- The only trace is the recipient's context. After epoch 2 it shows nothing but repeated "drp::node ::rendezvous: Room presence registration failures {failedRoomCount: 1}".
- Load was 60–70.
- Evidence:
  - log: <evidence>/verify-x/x-canvas.log
  - results and trace: <evidence>/verify-x/canvas-results/
  - unpacked trace: <evidence>/verify-x/canvas-trace/
  - the run script: <evidence>/verify-x/run.sh

Please find out whether your fix causes this. One possibility to rule out: the creator serving the recipient's retained-history requests (one a second while a vertex is held, plus one per install) in a way that blocks or starves its own seal, export or adoption. Another is a hang that exists without your fix.
- Reproduce with the creator's console captured. If the harness doesn't record the creator's console when a rollover hangs, add that as a measurement-only option.
- Run enough Canvas runs on your head, and on base for epochs 1–4 (base stalls at 5), to say whether the hang is new. Use per-run timeouts shorter than 30 minutes if that helps.
- If it's your fix: RED first, then the fix.
- Report back to me before you resume the startup-order work.

A smaller point. tests/phase-3a1-ac-live-persistence-red.test.ts already fails at base, but its private-WeakMap count went from 18 at base to 19 with your branch. A WeakMap you added is probably in a file that test scans. Don't edit the test. If the same state can live in an existing structure without a new private WeakMap, prefer that; otherwise note the +1 in RESULT.md.

I'm holding the merge until you report.

### Report returned by the agent (2026-10-21 17:49 UTC)

Track X: report on the Canvas harness hang. The startup-order work is paused until you reply.

**My fix does not cause the hang. Base has it too.** It is a deadlock in the creator's seal, and it only happens with IndexedDB storage. I reproduced it on base and on my head with the same IndexedDB pattern.

**The cycle** (code checked against head):
1. `close()` in packages/node/src/creator-close.ts takes the promotion source (line 3730) or the recovery source (lines 3740-3746, when `epoch >= 2`). It does this before `registration.stageSnapshot()` at line 3748.
2. Taking the source reaches `acquireClosedData`. At lines 7268-7271 of packages/node/src/internal/creator-closed-rollback-data.ts, `acquireJournalHeaderHold` keeps the live journal's native read reservation open. That is a readonly transaction (`HeldReadView`) on acceptedEntries, retirementControls and scopes. By design it blocks every native writer (packages/storage-browser/src/live-journal.ts 961-962 and 1662). It also takes two shared snapshot-recovery-dependency Web Locks. All of this sits outside the live plane's FIFO.
3. `stageSnapshot` then reaches `stageBlueprintEpoch` in v3-live.ts, which sets `blueprintClosing` and waits for earlier FIFO tasks, still holding the view.
4. An ingress task that was dequeued before `blueprintClosing` was set calls `liveJournalStore.appendAccepted`, even for a vertex the creator already has (it expects that append to change nothing). The append's readwrite transaction queues behind the held readonly view.
5. So the stage waits for the FIFO, the FIFO waits for the append, the append waits for the view, and the view waits for the stage. Nothing in that chain has a timeout.

Any creator ingress append in that window closes the cycle. Two triggers: the recipient's push of its retained rows (`#performRequest` sends them with every history request), or a Writer's new move.

**Evidence** (new opt-in probe, `TRACK_X_IDB_PROBE=1`):
- In every hang the creator is at step `seal` and has no network call in flight.
- The `HeldReadView` readonly transaction and the two shared locks open at the start of the seal. The readwrite `appendWriter` on the same stores opens 15-80 ms later. All three are still open 90-180 s later.
- Every hang is at harness epoch 3, which is the first seal with `epoch >= 2`.
- Every hang starts within about 40 ms of a recipient history request from the schedule that starts when the recipient opens (+6 s four times, +10 s once). Your run fits: the recipient joined at 12.25 s and the seal started at 18.32 s.
- The "presence registration failures" lines are a side effect, not the cause.

**Runs** (fast Canvas, 4 epochs, `TRACK_X_HISTORY_STORM_MS=250`, which makes the recipient send a history request every 250 ms):

| Library | Runs | Hangs |
|---|---|---|
| base 725f291b | 30 | 2 |
| 9b6b5f3f | 6 | 2 |
| 4787390d | 18 | 1 |

Every hang shows the same pattern. Without the storm: base passed 12/12 fast runs, and head passed 103 rollovers, mostly slow runs that never overlapped the open-time request window.

My fix adds history requests: one after each install, and at most one a second while a vertex waits for a dependency. Each one pushes the recipient's rows to the creator, so it can add triggers. These run counts do not show a difference between base and head.

**Hardening I added while ruling out your first suspect:** the creator's reply to a history request ran inside the FIFO as a direct send with no bound. A node-level RED shows one stalled reply holds the creator's moves, seal and close. The recipient's own history-request send had the same problem and could leave it permanently deaf. Both sends now get `AbortSignal.timeout(10_000)`. This adds no WeakMap and no call the WeakMap test forbids. No observed hang had a send in flight.

**Commits on top of f2d301d5** (none rewritten):
- 9b6b5f3f: RED for startup readiness (paused work)
- 270c7068: RED for a direct send that never completes (tests/track-x-stalled-direct-send-red.test.ts; both cases fail on 9b6b5f3f and pass with the fix)
- 76ea48f2: opt-in hang diagnostics for the harness (rollover timeout, step markers, network probe, full consoles)
- 4787390d: the direct-send deadline fix (v3-live.ts `republishRetained` and `RETAINED_DIRECT_SEND_DEADLINE_MS`; room-network.ts `#performRequest` and `HISTORY_REQUEST_SEND_DEADLINE_MS`)
- d46c3e74: harness IndexedDB/Web Locks probe, final closes bounded by the rollover timeout, and the storm option
- a2ef638b: RESULT.md section 9 (the hang, the run counts, the options, the WeakMap note)

**Decision needed: how to fix the seal deadlock.** I have not changed the seal path, because the native read reservation and the closed-rollback proofs carry G-guarantees.
- **Option 1 (I'd recommend this):** in `close()`, call `stageSnapshot` before taking the promotion or recovery source. The stage then empties the FIFO while no view is held, and later ingress returns early because `blueprintClosing` is set. If taking a source then fails, call `abortSnapshotStage`.
- **Option 2:** release the source before `stageSnapshot` and take it again afterwards with an identity check, the way `close()` already does around the archive work (3851-3916).
- **Option 3 (partial):** skip the journal append for a vertex the creator already has. A Writer's new move in the same window would still deadlock.

Option 1 or 2 needs a RED on the browser storage host (fake-indexeddb) that holds an ingress task in the FIFO when the seal takes its source.

**WeakMap +1:** `v3MissingDependencyRequests` (from 24699ced) is the 19th. It has to outlive every successor plane of a session. `v3PlaneRegistrations` holds per-plane registrations, and successor activation uses a closed key set, so neither can hold it. I kept it and noted the +1 in RESULT.md 9.5.

**Other notes:**
- **My Writer lost-move RED is flaky** (d48b57cd, tests/track-x-settlement-fence-delivery-red.test.ts). Under load, a trailing missing-dependency request can bring the "lost" move back before the test checks that it is missing. That happened twice, on head and base alike. I left the test unchanged, per the hard rules. Proposed change: wait a little over one request interval before losing the move.
- I killed my own leftover processes once, after storm-head-2; it is recorded in PROGRESS.md. Ports 4175/4180/4181/51000/51002 are now held by Track W's worktree, not by me.
- My worktree is clean at a2ef638b, with node dist built from head.

**Startup order (paused):** the RED 9b6b5f3f is committed. The prototype on scratch branch track-x-startup-integration breaks d9346 with NATIVE_READ_RESERVATION_BUSY when it creates a zone. It would also need the order pinned in creator-ordinary-readiness-producer.test.ts changed. I expect to come back to you with options there. I'll resume when you reply.

Files: <evidence>/track-x/PROGRESS.md; <worktree agent-a9ab847b594d95e7f>/docs/realtime-latency/tracks/34-track-x-settlement-fence-delivery/RESULT.md (section 9); hang logs in <evidence>/track-x/logs/ (storm-head-2, storm-idb-head-4, storm-fix-b-5, storm-base-b-15, storm-base-b-16; summaries in *.summary; `python3 bin/hung-summary.py <log>` prints the open transactions).

### Follow-up instruction — Deadlock: do Option 1; fix flaky RED first (2026-10-21 17:50 UTC)

Coordinator here. Thanks; the diagnosis is clear. I accept that the hang predates your fix. Decisions and order of work:

1. FIRST: your flaky Writer lost-move RED (d48b57cd, tests/track-x-settlement-fence-delivery-red.test.ts). It isn't on main yet, so it is your own new test and you may fix its race. Make a new commit that waits a little over one request interval before losing the move, with the assertion unchanged. Then run that file enough times under load to show it's stable, and send me the commit hash with a one-line note. I'll merge your work up to then, apart from 9b6b5f3f (the startup RED), which stays with the startup work. Then keep going with step 2; don't wait for me.

2. THE SEAL DEADLOCK: Option 1 (coordinator decision). In `close()`, call `stageSnapshot` before taking the promotion or recovery source, and call `abortSnapshotStage` if taking the source fails.
   - RED first, committed before the fix: on the browser storage host (fake-indexeddb), an ingress task is held in the FIFO when the seal takes its source. Cover epoch ≥ 2 (the recovery source) and the promotion source. Cover both the default six-database host and the room-database host (`createBrowserV3RoomDatabaseStorageHost`): Track Z will make the room database the default for new rooms, so the fix has to hold there. If the room host can't deadlock this way, show why.
   - Argue Option 1 against each guarantee it touches: the native read reservation, the closed-rollback proofs (CRD), G3, G4, G14, G17 and G23. Say what the source-before-stage order protected, and why stage-before-source keeps it.
   - If Option 1 breaks a proof, a pinned order, or a test that evaluates close() source text, stop and report, with Option 2 as the fallback. Do not edit any pinned test.
   - Proof:
     - the RED green;
     - the storm harness (`TRACK_X_HISTORY_STORM_MS=250`, `TRACK_X_IDB_PROBE=1`) with 0 hangs in at least 30 head runs (base was 2 of 30);
     - 16/16 normal runs for Canvas, Chat, and Grid with Track V's commits;
     - the bench at 8 rollovers, paired against your current head;
     - per-test suite diffs, typecheck and the shadow guard.
     Add a RESULT.md section.

3. THEN the startup order (decision row 45). When you have options, including the NATIVE_READ_RESERVATION_BUSY failure and the order pinned in creator-ordinary-readiness-producer.test.ts, report them and stop. Don't amend that test.

The WeakMap +1 (`v3MissingDependencyRequests`) is accepted as recorded in RESULT.md 9.5. The `AbortSignal.timeout(10_000)` hardening is fine, and it merges with step 1.

Parallel work is unchanged: Track Y has the cache files, Track W has examples/chat, and Track Z will start in the library's host selection after your step-1 commits merge. Keep each step in its own commits on your branch, without rewriting earlier ones.

### Report returned by the agent (2026-10-21 18:04 UTC)

Track X step 1 is done: e26cd812 fixes the race in the Writer lost-move RED, with the assertions unchanged, and it held in every run under load.
- The fix: before it loses the move, the test now waits until the recipient and the creator have exchanged no direct message for 1.5 s, a little over one 1 s request interval. That lets a trailing missing-dependency request and its reply finish first.
- Runs, all on e26cd812: the two lost-move cases 24 times, 4 at a time, load 25-150: 24/24 pass (48 cases). The whole file 16 times, 8 at a time, load 41-71: 16/16 pass (64 tests).
- To merge, take the branch through e26cd812 without 9b6b5f3f (the startup RED). That range also includes 270c7068, 76ea48f2, 4787390d, d46c3e74 and a2ef638b.
I'm continuing with step 2, the seal deadlock RED.

### Follow-up instruction — Merging your work; port coordination for an hour (2026-10-21 18:07 UTC)

Coordinator here. I'm merging your work now, on scratch branch verify-track-x2 in another worktree:
- f2d301d5;
- the fixture half of 9b6b5f3f, as a separate commit (65505659). The startup RED file stays only on your branch;
- 270c7068, 76ea48f2, 4787390d, d46c3e74, a2ef638b and e26cd812, cherry-picked.
Main is now 369420d0, which includes Track Y's merge (cache ceilings in canonical, protocol-v3, storage and node).

For the next hour or so, my verification runs the Canvas/Chat e2e and your shipped-app harness, which use the fixed ports 4175, 4180, 4181, 51000 and 51002. Before you start a Chromium run on those ports, check they're free (for example `lsof -nP -iTCP:4180 -sTCP:LISTEN`), and wait if they aren't. My script waits the same way. Node-level work, like your deadlock RED, isn't affected.

When I've merged, I'll tell you the main hash. Your later work (the deadlock fix, then the startup order) should then rebase onto main, or merge main in. Your branch still has 9b6b5f3f, which is fine.

### Follow-up instruction — Machine Node default changed; pin PATH (2026-10-21 18:17 UTC)

Coordinator here: an environment change you need to know about. At 14:07–14:08 something outside this session installed Node 22.23.4 and 24.22.1 through fnm and moved fnm's default alias from v22.15.0 to v22.23.4. The new default has no pnpm, so `pnpm` now fails with "command not found", and bare `node` is now 22.23.4.

To keep your runs comparable with everything before 14:07, put this at the front of PATH in every script and shell, and record it in PROGRESS.md:
export PATH="<fnm>/node-versions/v22.15.0/installation/bin:$PATH"
That directory has node v22.15.0 and pnpm 10.24.0, the repo's packageManager. Don't change the fnm default or install anything globally.

Check any run since 14:07 for "pnpm: command not found" or for node 22.23.4. Rerun those, and never pair a run on 22.23.4 with one on 22.15.0.
