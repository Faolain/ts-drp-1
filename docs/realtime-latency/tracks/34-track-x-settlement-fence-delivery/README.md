# Track X: the settlement fence delivery stall

**Outcome:** Fix merged in cf6d306f (4122ab83..e26cd812, without the startup-readiness RED). A recipient now asks the creator again for a missing dependency, so the settlement fence that arrives before install is no longer lost; shipped Canvas and Chat and the Grid with Track V's switch run 16/16 with real networking. The IndexedDB seal deadlock fix is picked as 04f7fd0b..9b28e327 (row 53): the seal stages its snapshot before it takes a journal source. The startup order (option A) and the readiness ingress hold merged in 8595826c (rows 51, 55 and 59). IN PROGRESS: play during a rollover, and d9346's migration failure (row 60), with the owner's successor-serving gate (row 61) and the R5 journal fix (row 62). See [RESULT.md](RESULT.md).

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

### Follow-up instruction — Your fix is merged; main is 24d4ca61 (2026-10-21 18:56 UTC)

Coordinator here. Your work is merged into main (codex/phase3a1b-p6-golden-path), now 24d4ca61. That's f2d301d5 merged, then the fixture half of 9b6b5f3f as 65505659, then 270c7068..e26cd812 picked as eeddd65a..cf6d306f.

What I checked with Node 22.15.0 pinned and Track Y underneath:
- typecheck 0 and the shadow guard clean;
- your four RED files passing, with the fence RED three more times;
- every room and Canvas/Chat test passing;
- the Grid bench in LULL=1 and concurrent modes;
- Chat and Canvas with real networking 16/16;
- the Canvas/Chat e2e 9/9.

Decision rows 48 and 49 and your track folder are recorded on main.

For your next commits (the seal deadlock, then the startup order), rebase onto 24d4ca61 or merge it in. The startup RED (9b6b5f3f) and its fixture are still only on your branch, as agreed, and the fixture's changes are already on main as 65505659.

Track Z has started, from 24d4ca61. It's working on making the room database the default for new rooms. It won't edit creator-close.ts, and it will report before touching v3-room.ts. Your deadlock fix has to cover the room-database host as well as the default host.

### Report returned by the agent (2026-10-21 20:32 UTC)

Track X step 2 (seal deadlock, Option 1) is done and proven; moving on to step 3 (startup order options).
Branch worktree-agent-a9ab847b594d95e7f: e1f471bb RED, 2a65f450 fix, b8ad1f50 merge of main 24d4ca61 (no rewrite), 75a16b81 docs (RESULT.md section 10).
- Fix: in close(), the stageSnapshot block and `lifecycle = "sealed"` move ahead of the promotion and recovery sources. No other change, and no test pins that order.
- One departure from row 49: I do not call abortSnapshotStage when a source fails. Once the stage has folded, it returns false and changes nothing (v3-live 19774-19779). So a source failure leaves the close "sealed" and retryable, which is what any failure after the stage already did at base. If you want the old "back to active" outcome, the alternative is to split the stage: drain first, take the sources, then fold. That needs a new close-registration step in v3-live.ts and a check that nothing admitted meanwhile writes the journal (RESULT 10.2).
- RED, base vs fix: hangs 4/4 at main's code (both hosts, both sources); passes 4/4 at the merged head. The control passes 4/4.
- Storm harness at the merged head: 31/31 counted runs pass with 0 hangs (base 2/30). One run is not counted: my own node suite's firewall.test.ts rebuilt packages/node/dist under Vite and reloaded the page.
- Real networking at the merged head: Canvas 16/16, Chat 16/16. Grid with Track V's 4 commits, on scratch branch track-x-grid-seal: 3 runs, all 16/16.
- Bonus: the fix also removes Track M's NATIVE_READ_RESERVATION_BUSY seal race. With no settle before a seal, base fails 13 of 16 runs ("recovery role transfer source failed: internal-invariant") and the fix fails 0 of 16. A probe shows the cause: an admitted ingress task holds the journal view (acquireLocalReplacementCustody, then resumeJournalReads) when the source is taken. So the 300 ms settles could go.
- Bench, 8 ABBA pairs at 8 rollovers, base vs fix: seal 3392 vs 3481 ms, adopt 687 vs 704, install 2065 vs 2091, issue 53.7 vs 55.0, delivery 121.5 vs 124.1. Recipient install, which this code doesn't touch, moves the same way, so I read it as load noise (load 160-350).
- Suites, per test, base vs fix: no new failures. Root has one each way, both explained: a vite SSR import race that passes alone, and a timeout on the base side. pnpm -r typecheck: 0 errors. Shadow guard: clean.
Note for anyone running Chromium proofs next to suites: packages/node/tests/firewall.test.ts and sync-state-heap-recharacterization-1o-f-ii-red.test.ts rebuild packages/node/dist from the worktree's src.

### Follow-up instruction — Accept X's seal fix departure; verifying now (2026-10-21 20:34 UTC)

I accept the seal-fix departure from row 49 (a source failure leaves the close sealed and retryable, and abortSnapshotStage is not called once the stage has folded). I'm verifying e1f471bb, 2a65f450 and 75a16b81 by cherry-picking them onto main 24d4ca61. Your merge commit b8ad1f50 would bring tests/track-x-settlement-startup-readiness-red.test.ts onto main, and that RED stays on your branch until step 3 fixes it. I'll merge once my checks pass. Carry on with step 3 and hand back the startup-order options without implementing a choice the owner hasn't made. Leave Track M's 300 ms settles alone for now; I'll raise removing them separately.

### Report returned by the agent (2026-10-21 21:26 UTC)

Track X step 3 (startup order, row 45) is done as options only. Nothing is implemented. On my branch the head is now b9335db0 "docs: record the startup-order options" (RESULT.md section 11, a summary bullet and a commits row; prettier clean). The startup RED from 9b6b5f3f stays red here. I did not edit creator-ordinary-readiness-producer.test.ts. Track M's 300 ms settles are untouched.

**What makes readiness wait**
- The barrier is `rebasePromise` (v3-room.ts:5705-5726). It runs bootstrap, then `publishAccepted`, then the drain, then prepare.
- Every publication is a plane FIFO task: `publishPending` (v3-live.ts:16156) awaits `publishMessage` at 16248.
- `waitForSubscriber` (network node.ts:2929) then waits up to 1 s for a subscriber, and after that publishes to no one.
- `room.issue` awaits the same barrier (v3-room.ts:7278).
- The wiring test pins this order: v1 must call `[enqueue, bootstrap, publish, drain, prepare]` (lines 1578-1627). Any new identifier in the barrier text also breaks it.

**The prototype** (scratch branch track-x-startup-seal, ef37befb)
- On v1 the drain issues locally, readiness is prepared, then every accepted row is published, and only then does the barrier resolve. The creator's own gossip republication of its history is held until the barrier settles (at most one).
- The startup RED passes.
- The wiring test fails only on the pinned order.
- Shipped Grid (d9346), prototype plus the seal fix: 9 of 9 runs pass both tests. Without the prototype, line 474 still fails.
- Prototype on main's creator-close.ts: 10 of 12 pass, 1 BUSY, and 1 rollover transfer failure ("snapshot peer has no open unlimited authenticated connection", no BUSY, not seen elsewhere).

**The NATIVE_READ_RESERVATION_BUSY**
I caught both stacks with a probe patched into the built storage-browser code (run md9-proto-presl-3).
- **Holder:** `acquireCreatorIssuanceMaintenanceProof`. It held the creator's `--ahe` read view from 3606 ms, before the Writer connected. The zone was at epoch 0, so no close was running.
  - Local issues run their maintenance inside the plane FIFO (`enqueueLocalIssue`, v3-live.ts:15149-15158), so they cannot overlap ingress.
  - That leaves the readiness job as the holder: `prepareOrdinaryReadiness` (creator-close.ts:4677, outside the FIFO) → `captureCreatorOrdinarySourceWithoutForecast` (2460/2473).
  - This is by elimination. A second probe that would name the caller never fired: 14 more runs had no BUSY.
- **Refused:** the Writer's first append. `handleV3Ingress` (v3-live.ts:7556-7569) takes custody before it asks the maintenance consumer. On the browser the reservation refuses at once, and the catch returns false without keeping the append.
- **The asymmetry:** when the consumer refuses for the same reason, the append is kept as pending ingress (7730-7737), as the comment at 7471 says it must be. So this is a drop that already exists in the code; the reorder only lines it up with the first join. The same path exists at startup and at successor installs (v3-room.ts:5716, 6667), though I never saw it without the prototype.
- The seal fix changes only close(), so it shouldn't matter here. 9/9 against 10/12 is not evidence that it does.

**Options for the owner** (each of A, B and C needs one BUSY fix)
- **BUSY fix (i), smallest:** keep the append as pending ingress when custody is refused, as the consumer path does. It is bounded by maxPendingEntries/Bytes and counted in the census (G21). Also retry when the maintenance job ends; today pending ingress is retried only after the next successful ingress (7974).
- **BUSY fix (ii):** run the readiness job as a plane FIFO task. Bigger, and ingress waits behind the cold capture.
- **A. Reorder on v1 (the prototype).** "Started up" still means "published", and publications still wait for a subscriber. The owner has to amend the pinned wiring order to `enqueue, bootstrap, drain, prepare, publish`. One cost remains: a placement made while the creator is still alone still waits for the last publications, but it builds nothing.
- **B. Background publisher.** The barrier text stays, so the pinned test passes by its letter, but its "after startup publication" meaning stops being true. It needs a no-wait subscriber check, a "deferred" egress result and a bound. G19 holds issuance retention while rows stay pending. Not prototyped.
- **C. No subscriber wait when the topic has none.** Smallest diff, but it changes every app and both profiles. The startup RED's assertion that the startup publications reach the Writer by gossip would fail. Not prototyped.
- **My preference, for the owner to decide:** A with (i).

**Worktree state**
- Back on worktree-agent-a9ab847b594d95e7f at b9335db0, tree clean.
- Dists are rebuilt from the branch: no probes, no prototype, and the stage-first fix is present.
- Rebuilding normally after touching the files did not remove the dist probes, because `tsc -b` compares content. I used `tsc -b tsconfig.build.json --force` for storage-browser and node, which did. This is recorded in PROGRESS.md.
- Scratch branches are kept: track-x-startup-seal and track-x-grid-seal.
- No processes of mine are left.
- One port collision on 4175 at launch; that log was renamed `*-porttaken` and excluded.

Files are in <evidence>/track-x/:
- PROGRESS.md
- logs/md9-proto-*.log
- data/md9-proto-presl-3-trace/console.txt
- bin/: patch-busy-probe.py, patch-maintenance-probe.py, busy-console.py, trace-snapshots.py, d9loop.sh

The full write-up is <worktree agent-a9ab847b594d95e7f>/docs/realtime-latency/tracks/34-track-x-settlement-fence-delivery/RESULT.md, section 11.

### Follow-up instruction — Owner chose startup option A with BUSY fix (i); implement (2026-10-21 21:30 UTC)

The owner chose startup option A (prepare readiness before publishing, on v1) with BUSY fix (i) (keep the append as pending ingress on a custody refusal, and retry when the maintenance job ends). Implement both on your branch (it already has the stage-first fix, which I'm verifying for main now).

Pinned-test amendment the owner approved: in packages/node/tests/creator-ordinary-readiness-producer.test.ts (1578-1627), only the v1 expected order becomes ["enqueue", "bootstrap", "drain", "prepare", "publish"], and the test title's wording may change if it no longer describes the order. Make it its own commit, with a message naming the owner's approval (decision row 51). Keep the barrier text to the identifiers the stubs already define, as your prototype did. If any other change to that test, or to any other RED, governance or frozen file, turns out to be needed, stop and report before making it.

Order of work:
1. RED for (i), committed before the fix. A custody refusal on a creator bound for maintenance (handleV3Ingress, v3-live.ts:7556-7569) loses the append today. The RED should show the append kept as pending ingress and admitted once the maintenance job ends, without waiting for another ingress. Use the node host if you can reproduce it there; if you can't, use whatever fixture shows it, and say which.
2. Implement A (the prototype's shape) and (i). Keep pending ingress bounded by maxPendingEntries/maxPendingBytes and counted in the census (G21). Make the retry event-driven, not a timer. Keep edits to v3-room.ts minimal and list every function you touch: Track Z may later touch host selection there.
3. Proof:
   - the startup RED (9b6b5f3f) and the new (i) RED green, the amended wiring test green, and your seal RED still green;
   - shipped Grid (d9346) with Track V's 4 commits (d5a0015f, 15bf2ed1, 5b55b6e9, 27fe2688) on a scratch branch: at least 6 runs, both tests;
   - shipped Canvas and Chat with real networking, 16/16 over 2 runs each;
   - the bench at 8 rollovers in default mode and in room database + LULL=1, paired against base;
   - per-test suite comparison against base (node; root room and native tests including Tracks K-X; storage, storage-browser and storage-node; the Canvas/Chat e2e);
   - pnpm -r typecheck 0 errors, and the shadow guard.
   Also confirm that V's 4 commits apply cleanly on your head.
4. Add RESULT.md section 12 and a commits row, then hand back with the commit list.

Leave Track M's 300 ms settles alone. Keep the Node PATH pin, the port checks, and `tsc -b --force` after removing probes.

### Report returned by the agent (2026-10-21 21:32 UTC)

Track X: the approved wiring-test amendment can't pass as worded, so I need one more change approved.

packages/node/tests/creator-ordinary-readiness-producer.test.ts:1602-1612 checks `room.calls` at the moment prepare is entered (line 1609, `await enteredPromise`). The prepare stub is still gated at that point, and the test only calls `release()` afterwards. Under option A, publish runs after prepare, so at line 1609 the calls are ["enqueue", "bootstrap", "drain", "prepare"]. The approved 5-element list can't hold at that line.

Smallest change that keeps the test's intent (preparation joins before the barrier resolves, and now before publication):
1. Line 1609, v1: ["enqueue", "bootstrap", "drain", "prepare"].
2. After `await room.done;` on line 1611, add `expect(room.calls).toEqual(["enqueue", "bootstrap", "drain", "prepare", "publish"]);`.
3. Title: "joins preparation after the startup rebase, before startup publication and before the existing barrier resolves".

The NONE and receive-only test and the swap test stay unchanged; both pass with A's barrier text.

Is this approved? Until I hear back I'm doing the (i) RED and the implementation, and I won't touch the test.

### Follow-up instruction — Owner approved the refined wiring-test amendment (2026-10-21 21:34 UTC)

The owner approved your refined amendment to packages/node/tests/creator-ordinary-readiness-producer.test.ts, exactly as you wrote it:
- line 1609 (v1) becomes ["enqueue", "bootstrap", "drain", "prepare"];
- after `await room.done;` (line 1611), add `expect(room.calls).toEqual(["enqueue", "bootstrap", "drain", "prepare", "publish"]);`;
- the title becomes "joins preparation after the startup rebase, before startup publication and before the existing barrier resolves".
The NONE/receive-only test and the swap test stay unchanged. Commit it on its own, with a message naming the owner's approval (decision row 51). Anything further on that test, or on any other pinned file, comes back to me first.

### Report returned by the agent (2026-10-21 21:43 UTC)

Track X: fix (i) as approved turns the lost append into a terminal creator, so I've stopped on (i) and need a decision. Option A is unaffected and I'm continuing with it.

The RED, uncommitted for now: tests/track-x-custody-refusal-red.test.ts with tests/fixtures/track-x/custody-refusal-room.ts. It runs on the node SQLite host, which reproduces this: the storage-node owner also throws BUSY at once when it already holds a reservation (storage-node native-read-reservation.ts:61).
- The creator reopens. Its startup readiness job (captureCreatorOrdinarySourceWithoutForecast → acquireCreatorIssuanceMaintenanceProof) already holds the AHE, journal and issuer views and is about to reserve the floor. At that moment the Writer's move reaches the creator's ingress.
- The move's custody is refused before it reaches the floor (BUSY on the AHE view).
- **At base:** the move is never admitted within 15 s of the job's end (logs custody-red-base-r3). The RED fails for the right reason.
- **With (i)** (keep the append as pending ingress when custody is refused): the RED fails with "creator held issuance census is unavailable" (custody-red-scratch-i-r1).
  - The readiness job holds an issuance census that requires pending ingress to stay unchanged (`live()` → `pendingCurrent()`, v3-live.ts:11007/11041).
  - Keeping the append changes pending ingress, so the job's next reservation check fails (creator-closed-rollback-data.ts:6785).
  - The startup barrier then fails, and the creator becomes terminal.
- At base, a Writer row with a missing dependency is also kept as pending (7966), and it kills readiness the same way. That is exactly Chromium md9-proto-presl-3: BUSY, BUSY, graph-rejected, then "creator held issuance census is unavailable", then the creator leaves the room.
- The retry half of (i) already exists: the readiness and pool jobs call `registration.resumePendingIngress()` when they end (creator-close.ts:4804 and 4906; v3-live.ts:19906).

So no ingress may touch the plane while the readiness job holds its census. Options:
- **(a) Recommended. Run the readiness capture in a plane FIFO slot,** as `runCreatorOrdinaryReadinessMaintenance` already does for readiness maintenance and pool lulls (v3-live.ts:19660-19674).
  - That slot sets the closing gate with `readinessMaintenanceEntered`, so arriving ingress queues FIFO behind it (enqueueV3Ingress, 8184-8189). Nothing is dropped and nothing is refused: this is G23's existing pattern.
  - The changes are in creator-close.ts `prepareOrdinaryReadiness` plus a v3-live registration entry point. The RED's setup would change: the move would wait in the FIFO instead of reaching custody. The test would still require the move to be admitted after the job and the creator to stay live.
  - Risk: the capture must not enqueue plane tasks itself, or it deadlocks the way the seal did. sealCreatorRecoveryDependencies does not, and readiness maintenance already seals inside such a slot. I'd prove the rest.
- **(b) (i) plus one bounded readiness retry** when its census is invalidated by ingress. This changes startup failure semantics, and a steady stream of appends could still fail it.
- **(c) (i) as specified.** Counterexample above: the creator becomes terminal.

I'd keep (i)'s retain as well under (a), for other holders that can still refuse custody (for example retained reads in withCurrentRetainedRead), but only together with (a).

Which do you want? Meanwhile I'm committing the approved wiring-test amendment and implementing A. No proof runs until this is settled.

### Follow-up instruction — Owner chose (a): readiness capture in a plane FIFO slot (2026-10-21 21:44 UTC)

The owner chose (a): run the readiness capture in a plane FIFO slot, as runCreatorOrdinaryReadinessMaintenance already does, so ingress that arrives meanwhile queues FIFO behind it and nothing is dropped or refused. Keep (i)'s retain-on-custody-refusal as well, for other holders, but only together with (a). The fix (b) retry is not wanted. This replaces (i)-alone in decision row 51.

Conditions:
- Commit the RED before the fix. It may change its setup so the move waits in the FIFO, but it must still require that the move is admitted after the job and that the creator stays live. Keep the node-host custody-refusal case as a separate test of (i)'s retain under (a), if it can still be reached through another holder; if it can't, say so.
- Prove the capture enqueues no plane task of its own on any path, at startup and at successor install (v3-room.ts:5716, 6667), so it cannot deadlock the way the seal did. Add a test for it if it can be checked.
- Measure what the slot costs real-time play. Give the wait an ingress move sees behind the readiness slot, as p50/p90/max, at startup and after each successor install. Also give move delivery and the creator's first-move latency per epoch, paired against base, with the bench at 8 rollovers in default mode and in room database + LULL=1, and with shipped Grid/Canvas/Chat over real networking. If the slot adds a per-epoch wait that real-time play would notice (say tens of ms at p50 after installs on a warm room, beyond the load noise), stop and report before going further.
- Everything else in my previous message stands: the d9346 runs with V's commits, the per-test suite comparison, typecheck, the shadow guard, RESULT section 12, and the hand-back.

### Report returned by the agent (2026-10-21 22:00 UTC)

Track X: (a) as written leaves a hole that makes the creator terminal, and implementing it would change two pinned source texts. I propose a refinement below and need a yes or no before I implement it. Meanwhile I'm implementing A and writing the RED, which doesn't depend on the choice.

1) The hole. A readiness job captures first, and when that source isn't certified, or recovery is required, it then runs `registration.runOrdinaryReadinessMaintenance` (creator-close.ts 4724-4760). The ingress queued behind the capture slot runs before the maintenance slot does (it is a single FIFO). The consumer refuses it while the readiness job is in flight (creator-close.ts 3438), so v3-live.ts 7733 keeps it as pending ingress. The non-deferrable maintenance boundary requires `pendingIngress.size === 0` (v3-live.ts 11400, rechecked at entry in 11417). It throws, readiness fails, and the startup or install barrier makes the creator terminal. So under (a) an append that arrives during the first capture becomes a terminal creator whenever maintenance follows.
   - Base has the same chain in a narrower window (an arrival between the capture and the maintenance, or before the maintenance on the required path).
   - Separately, the readiness maintenance is non-deferrable, so `enqueueV3Ingress` (8186) drops new arrivals while it runs.

2) Pinned texts. Two tests run these functions from source against stubs:
   - packages/node/tests/creator-ordinary-readiness-producer.test.ts (closeReadinessJob, 803-860) runs the actual `prepareOrdinaryReadiness` text against a stub registration. Any new call in that text, such as a `registration.runOrdinaryReadinessCapture(...)` wrapper, needs one stub line added to that pinned test.
   - creator-recovery-pool-gameplay.test.ts and producer test line 420 run `runCreatorOrdinaryReadinessMaintenance`, so it can't take new identifiers either. A whole-job slot would deadlock on its nested enqueue anyway.

3) Proposed refinement (same intent: arrivals queue behind readiness, nothing dropped or refused, event-driven, bounded). Neither pinned text changes:
   - `prepareCreatorOrdinaryReadiness(plane)` (creator-close.ts 5002, not pinned) takes a readiness ingress hold before it starts the job. The hold is a new creatorCloseRegistration method in v3-live. It sets a per-registration hold promise, then enqueues one empty FIFO task and awaits it as a flush, so every earlier queued ingress finishes before the job starts. It resolves the hold in a finally once the job has joined. This is the job that already calls `resumePendingIngress`.
   - `enqueueV3Ingress` waits on that hold through its existing barrier option (`inputAdmission.barrier`, which already serves `terminalBarrier`, with `captureBeforeBarrier`). An arrival is captured and charged to the input pool (32 jobs, maxPendingBytes, G21), waits outside the FIFO and outside pendingIngress, then enters the FIFO in arrival order when the job ends. While the hold is set, the closing-gate drop at 8186 queues instead, so the readiness maintenance phase drops nothing either. That boundary keeps the epoch, as the pool's does. A failed boundary still drops at authentication under the halt, as for the pool today.
   - Effect: pendingIngress and the graph stay fixed for the whole job. The capture census and the maintenance boundary can't be invalidated by ingress, and no ingress reaches custody during readiness. (i)'s retain stays for other holders.
   - Deadlock: the job waits only for the flush and its own maintenance slot. No FIFO task waits on the hold. My static pass over packages/node/src (call graph from refresh, the cold capture and metadata) reaches no FIFO enqueue. The pool's `after` already runs the same cold capture inside a FIFO slot.
   - Measurement: I'd report the wait an ingress sees behind the hold (p50/p90/max, at startup and after each install), plus the other numbers you asked for.

4) What it doesn't cover. Other FIFO work, such as retained-history reads (`withCurrentRetainedRead` holds all four reservations), can still overlap the capture and BUSY it. That hazard already exists. Adding a capture slot on top would close it but needs the stub line in (2). Optional.

5) (i)'s separate test. After the hold, the readiness job is no longer a holder. The production holders left outside the FIFO are:
   - v3-room.ts 5383, the split replacement's floor view during the drain, which a readiness job always follows, so its end resumes;
   - the migration target floor;
   - the seal, whose closing gate drops ingress.
   None can be driven on the node host without a split replacement or a migration. So I'd test (i) with the test itself holding the creator floor's native reservation, standing in for 5383. The retained append is then admitted at the next drain trigger: the creator's next move, an admitted ingress, or a job end.

Can I go ahead with 3 (and 4 or not)?

### Follow-up instruction — Approve the readiness hold (3); not the capture slot (4) (2026-10-21 22:00 UTC)

Yes to (3), the readiness ingress hold. It meets the owner's intent for row 51: arrivals wait behind readiness, nothing is dropped or refused, and no pinned text changes. I'll record it as how row 51 is implemented.

No to (4) for now. The hazard predates this work, and it would need a pinned-test stub line, which is the owner's call. Record it in RESULT.md as an open item: retained reads can BUSY the capture, and the fix is a capture slot plus one stub line in creator-ordinary-readiness-producer.test.ts.

For (3), cover these with tests, where the node host can reach them:
- The hole from your point 1: an append arrives during the capture of a readiness job whose source then needs maintenance. It must be admitted after the job, and the creator must stay live. This should fail at base or with (a) as first written.
- close() is called while the hold is set. Close still waits for the job, and the held arrivals then meet the closed gate exactly as they would today. No hang, and no arrival admitted after the stage.
- The input pool fills while the hold is set (32 jobs or maxPendingBytes). Say what happens to the next arrival, and show that it is the existing refusal behaviour, not a new drop path.
- The hold is released on every path: job success, failure, terminal failure, and a throw in the flush.
- The seal's closing gate still drops while no hold is set. Only readiness maintenance under the hold queues instead.
Also state the argument that no FIFO task can await the hold. If it can be asserted cheaply (for example, a debug check that the hold is never awaited from inside a FIFO task in tests), add it.

(i)'s separate test with the test holding the creator floor's native reservation is fine. Name it as a stand-in for v3-room.ts 5383.

Measurements as before: the wait behind the hold (p50/p90/max) at startup and after each install, the bench pairs, and shipped Grid/Canvas/Chat. Stop and report if the per-install wait is noticeable for real-time play.

### Report returned by the agent

Track X: (i) breaks the creator's local issues, so I need a decision on it. The hold is unaffected and I'm continuing with it.

Finding. With (i), a custody-refused append is kept as a pending-ingress entry whose parents are all present. The creator census refuses such an entry unless it is the entered received append (v3-live.ts ~10240, readCreatorRecoveryDependencyCensus: `if (missingParents.length === 0 && active.enteredReceivedDigest === undefined) return undefined;`).
- The creator's next local issue therefore fails: "issuance-rejected ... creator recovery dependency hold unavailable:replay". The census is reached through prepareCreatorIssuanceMaintenanceQuote (creator-close.ts:2154).
- A failed issue drains nothing, so the creator can't play until a received append succeeds or a maintenance job ends.
- Node-host test standing in for v3-room.ts 5383 (the test holds the creator's floor reservation): at base the move is lost (logs/retain-red-base-r2.log); with (i) the creator's own next move is refused (logs/xreds-head-r1.log).

For the real 5383 holder it's worse. The split replacement acquires its floor view outside the FIFO, then runs source.withDependencies in a FIFO read-control slot while still holding the floor. That slot seals an active census (sealCreatorRecoveryDependencies with activeSource). Ingress queued ahead of the slot gets custody-refused. Under (i) it is kept, the census then refuses, and the split replacement fails. At base the append is dropped and the replacement goes on. So for that holder, (i) turns a lost append into a failed replacement.

Options:
1. Recommended: ship the hold without (i). Custody refusal by a non-FIFO holder drops the append, as at base. RESULT records the 5383 loss as an open item.
2. (i) plus a drain before each local issue. In issueLocal, a maintenance-bound creator with pending ingress drains it before issuing. A probe passes the stand-in test (logs/retain-alpha-r1.log). It does not help 5383: the floor is still held during that census, so the replacement still fails.
3. The 5383 replacement takes the ingress hold around its floor view, so arrivals wait instead of being refused, and (i) isn't needed there. This needs an edit to v3-room's replacement loop (Track Z's caution) and a hold exposed on the rebase source. It's a new decision.

Until you answer, I'm keeping (i) out of the fix commit; it's saved as a separate patch. I'm continuing with: the hold REDs (both fail at base and pass with the hold: logs/hold-red-base-r1.log, logs/xreds-head-r1.log), the hold fix, the hold property tests and the measurements. I'll add (i) in its own commit only if you choose 2 or ask for it.

### Report returned by the agent

Track X: the hold's wait numbers are in, I fixed one pin regression, and I found an adoption failure that predates row 51. Continuing with the proofs unless you say otherwise.

1. Pin regression, fixed in 0e7c068e (source only, no test edited). In the node suite, creator-recipient-recovery-pool.test.ts failed. It pins a regex on the closing-gate line in enqueueV3Ingress, and 04135190 had folded "&& hold === undefined" into that line. The hold check now sits on its own line before it, the pinned line is byte-identical to the one in A, and behaviour is unchanged. After the fix, the pin, the hold unit tests and pool gameplay (33/33) pass, and so do the hold REDs, close/seal, the startup RED and the seal RED (9/9). Node suite against base: that was the only new failure.

2. Wait behind the hold:
- Chromium bench at 8 rollovers, 4 runs, default and room-DB modes:
  - 0 moves arrived during a hold in 64 installs.
  - Hold window after installs: p50 64-66 ms, p90 77-82, max 96-105.
  - Hold window at create: p50 90-102. At reopen: p50 296 (default), 876 (room DB).
  - Delivery and the creator's first move per epoch are within noise of base (delivery 100.7 vs 99.5 default, 93.5 vs 93.8 room DB).
- Node host, worst case (a Writer move injected at the very start of the creator's readiness capture, 2 paired runs × 8 epochs):
  - Head: the move waits behind the hold p50 54 / p90 61 / max 66 ms, and is admitted p50 131 ms after arrival.
  - A without the hold: the same arrival makes the creator terminal at epoch 1 in 2 of 2 runs ("creator ordinary runtime custody is stale or revoked"), so there is no base wait to compare.
- Node host, Writer streaming moves from the start of the capture: every move arrives after the hold ends, because the Writer's issue takes 40-70 ms. 8/8 epochs complete.
- Moves streamed after adoption: head and A-only match (first move p50 129 vs 134 ms).

My reading: real-time play doesn't notice the slot. Only a move that lands in the ~60 ms window waits for it, and at base that same move loses the creator.

3. New finding, present at base (b8ad1f50 node source too, not caused by row 51). On the node host, if the Writer installs the successor and starts playing straight away while the creator adopts, the creator's adoption fails at epoch 1.
- Failure path: performCreatorSuccessorAdoption (v3-room 6711) → drainRebaseOutbox → drainSettlementOutbox → issueSettlement, which fails with "prospective runtime census has unresolved ingress or rebase dependencies" (v3-live prospectiveCreatorRuntimeCensusOverhead).
- That census refuses a non-received local issue whenever pendingIngress is not empty.
- A probe showed one pending Writer row, with one dependency missing from the creator's new plane, sitting there while the creator drains its own settlement row. The creator then goes terminal.
- Reproduction: TRACK_X_STREAM_FROM=install in <evidence>/track-x scratch test tests/track-x-scratch-hold-stream.test.ts.
- I haven't fixed it. It needs a design call (the census rule versus the drain order), and I don't know whether the shipped apps' adoption order can reach it. I'll list it as an open item in RESULT 12.

(i) is still waiting on your choice between options 1, 2 and 3. Next I'm running the stor and rootx base suites, paired Canvas/Chat runs (base vs head), and then the Grid scratch branch with V's 4 commits (d9346 ≥6 runs, plus the long room paired).

### Follow-up instruction — Owner chose option 1: ship hold without (i) (2026-10-21 23:36 UTC)

The owner chose option 1: ship the hold without (i). A custody refusal by a holder outside the FIFO drops the append, as at base. Keep the (i) patch out of every commit (store it under <evidence>/track-x). In RESULT 12, record as open items the 5383 loss (with your option 3, holding ingress around the split replacement's floor view, as the candidate fix) and why (i) failed (the census refuses an entry with all parents present, so the creator's next local issue fails).

Main has moved to ebf4254f: Track W's Chat window plus your seal fix, picked as 04f7fd0b..9b28e327 (your e1f471bb, 2a65f450, 75a16b81 and b9335db0) with docs. Before your proofs, rebase or merge your branch onto it, so the grid scratch branch and the suite comparisons are against current main. The picks are identical to your commits, so the merge should be clean.

Your wait numbers look fine (p50 64-66 ms after installs, with no moves arriving in that window in 64 installs). Carry on with the proofs.

On the adoption failure you found at base (a Writer playing straight after its install while the creator adopts leaves a pending Writer row, the census refuses the creator's settlement drain, and the creator goes terminal at epoch 1): don't fix it in this track. After the proofs, and before your hand-back, spend a bounded effort (about an hour) on whether shipped Grid, Canvas or Chat over real networking can reach it. For example, run the shipped harness with the Writer moving right after install, and check d9346. Then give the design options (the census rule versus the drain order) in RESULT 12 with a recommendation. If it is reachable on a shipped page, say so at the top of your hand-back. It would then become its own track.

### Report returned by the agent (2026-10-22 00:14 UTC)

Track X heads-up on the adoption-drain finding: in the shipped order, one Writer move during the creator's seal is enough to fail the creator's next adoption, and main's node source does the same.

The shipped order here is: the creator seals, exports and adopts, and only then does the Writer install. I ran it on the node host with a scratch test (tests/track-x-scratch-drain-race.test.ts, untracked; logs in <evidence>/track-x/logs/race-*):
- The Writer makes one move 50 ms into the creator's seal (TRACK_X_CAP=1). At epoch 1 the creator's adopt then fails.
- Failure path: drainRebaseOutbox, then drainSettlementOutbox (v3-room 5348, the settlement replacement), then issueSettlement, which fails with "authorization-rejected: active replacement source custody refused: portable source protected dependency is unavailable" (v3-live 6782, in the portable replacement's dependency walk).
- The same happens when the Writer moves only during the seal, only during the adopt, or across both. It fails 3 of 3 at head and also at main's node source (ebf4254f), so it predates row 51.
- The reverse case is clean: the creator playing while the Writer installs completes 6 of 6, at head and at main.
- This is a different refusal from the one I sent earlier (the post-install case, which only happens in the fixture's install-before-adopt order).

Shipped Canvas and Chat cannot reach it, because their joiners are receive-only observers that never move.

Grid can only be tested on the scratch branch with V's commits. Once the suites finish, I'll try a scratch copy of Track V's Grid harness in which the Writer places a block every 100 ms during the creator's seal, export and adopt.

Every shipped harness so far pauses moves during rollovers, which is why none of them has hit this.

### Follow-up instruction — Ack drain-race finding; plan it as X's next step (2026-10-22 00:15 UTC)

Thanks, this is important. For real-time games, play during the creator's seal and adoption is the normal case, so it can't stay an open item. Plan:

1. Finish the startup work and its proofs as planned, and include the Grid check with a Writer placing every 100 ms through seal, export and adopt.
2. Make the drain race the next step of this track, after I've verified and merged the startup fix. Don't start the fix before then, so the startup branch stays clean.
   - Commit the scratch test as a proper RED first, with both orders and both refusals: the seal-time move ("portable source protected dependency is unavailable") and the install-before-adopt move ("prospective runtime census has unresolved ingress or rebase dependencies").
   - Root-cause both, and give options in RESULT section 13. If the fix needs a guarantee-level or pinned-text choice, stop there; otherwise go straight to the smallest fix.
3. In your hand-back for the startup work, add a short section on this finding: the exact repro, which shipped pages can reach it (Grid result included), and your first read on the cause.

Also, record in RESULT 12 that every shipped harness pauses moves during rollovers, so the latency figures to date assume that pause. The proof for the drain-race fix should include runs with continuous play through rollovers.

### Report returned by the agent (2026-10-22 00:16 UTC)

Track X correction to my heads-up: the seal-time refusal happens in the Writer's install, not the creator's adoption. The creator survives; the Writer is the one that ends up terminal.

I dumped both peers' settlement plans after the failure (logs/race-wds-cap1-plan-r1.log, main's node source):
- Creator: fence 4, no entries.
- Writer: fence 5, plus one entry {sourceSequence 4, disposition "rebase", replacement pending}. That entry is the move the Writer made during the creator's seal, which is not in the cut.

How the Writer fails:
- Its install runs performCreatorSuccessorAdoption(received), the same function as the creator's adopt, which is why I misread the stack.
- That goes through drainRebaseOutbox to drainSettlementOutbox (v3-room 5348, the replacement), which must rebase that move into the new epoch.
- The portable replacement's dependency walk (v3-live 6782) cannot find a protected dependency of the move, so the install throws.
- The received-adoption catch then sets terminalFailure, so the Writer is terminal (deaf). That breaks the "recipient never deaf" guarantee.

The install-before-adopt census refusal is unchanged: it is on the creator's adoption (the probe showed creatorMaintenanceBound).

Your plan is understood. I'll finish the startup proofs, including the Grid race run. I won't start the drain-race RED or fix until you have merged the startup fix. The hand-back will include the repro, the shipped pages that reach it and my first read on the cause, and RESULT 12 will note the rollover pause.

### Report returned by the agent (2026-10-22 03:07 UTC)

#### Track X: row 51 (A and the readiness hold) is done; the drain race can be reached on the shipped Grid page

**Top finding: play during a rollover makes a Writer terminal on the shipped Grid page, and main has the same bug.**
- I used a scratch copy of Track V's Grid long-room harness, with the Writer placing a block every 100 ms through the creator's seal, export and adopt.
- The Writer's install fails at epoch 1 in all three runs: 2/2 at head and 1/1 at main's node source. The error is: "v3 room settlement issue failed: authorization-rejected: active replacement source custody refused: portable source protected dependency is unavailable".
- Logs: `<evidence>/track-x/logs/hg-race-head-1.log`, `-2.log` and `hg-race-mseal-1.log`.
- The section on it is at the end of this report. As you asked, I have not started its RED or fix.

##### Commits on worktree-agent-a9ab847b594d95e7f
All end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed.

| Commit | What |
| --- | --- |
| 7256d607 | The owner-approved wiring amendment (row 51), committed on its own |
| f86f8a0a | fix: A, a settlement creator prepares readiness before its startup publication |
| 83176da6 | The hold REDs and a node-host fixture |
| 04135190 | fix: the readiness ingress hold |
| 9f143f3b | 15 unit tests pinning the hold |
| 0e7c068e | fix: keeps `enqueueV3Ingress`'s pinned closing-gate line unchanged (the pinned test was not edited) |
| 4f5fc446 | Clean merge of main ebf4254f; node source now differs from main's by A and the hold only |
| 23a569ac | docs: RESULT.md sections 12.1–12.10 and the commit rows |

(i) is in no commit. Its patch is `<evidence>/track-x/data/hold-fix-v1.patch` and its test is `data/track-x-custody-refusal-retain-red.test.ts`. RESULT 12.9 records the 5383 loss, why (i) failed, and option 3 as the candidate fix.

##### Proof
- **REDs:** at head, the startup RED (9b6b5f3f), the hold REDs, the close and seal tests, the amended wiring test, the seal RED and the 15 hold unit tests all pass.
- **Suites, per test, head vs main's node source:** 0 regressions in every set.
  - node: 1042/48 vs 1027/63. The 15 fixed tests are new-code tests.
  - Every other set is identical: storage-node 163/61, native6 35/15, observers 23/23, grid 65/65, Chat window 21/21, storage 1000/304.
  - root room and native tests (Tracks K–X): 1 new failure, a d110c load-order flake that passes alone. 7 fixed.
- **Typecheck and guard:** `pnpm -r typecheck` has 0 errors and the shadow guard passes, after `tsc -b --force` and a node dist rebuild.
- **Track V's 4 commits** cherry-pick cleanly onto 4f5fc446 (scratch branch track-x-hold-grid).
- **Shipped pages, real networking, paired base/head:**
  - Canvas 16/16 ×4 and Chat 16/16 ×4. Delivery p50: Canvas 112.5 / 110.5 ms, Chat 7.5 / 9.0 ms.
  - Grid long room 16/16 ×4. One head run was slow in every phase (seal 5–8 s); the other head run was the fastest of the four.
  - All of these harnesses pause play during rollovers. RESULT 12.7 records that every latency figure so far assumes that pause.
- **d9346, both tests, 36 runs with Track V's switch:**

| Build | Runs | Migration test fails at line 915 | Placement test fails |
| --- | --- | --- | --- |
| Main's node source | 8 | 1 | 4 (all at 534, Track V's known issue) |
| A only | 4 | 2 | 1 (at 419) |
| Head | 14 | 8 | 2 (at 534) |
| Head with a labelling probe | 10 | 0 | 0 |

  - **The migration failure is not caused by the hold.** It also fails at A only and at main's node source, and it depends on load. Head failed it 6 times in 10 at load 75–196 and 2 times in 14 at load 17–55. Main's node source was never run at high load, so its 1 in 8 is not a matched comparison.
  - What fails: after the migration, the rejoined joiner's "target-suffix" block never reaches the creator.
  - The probe only adds labels to admission refusals. In the labelled runs, bursts of 9–40 arrivals hit the existing 32-job input-pool refusal when a retained republication lands. My unproven reading: the block is refused there and is never asked for again, because nothing depends on it. It is not root-caused, and it is listed as an open item that should be settled before Track V's switch merges.
  - The A-only failure at line 419 is the hole that the hold closes, seen on a shipped page: custody refusals at startup, then the creator is terminal. It did not happen in 24 head runs.
- **Bench and hold-wait figures:** as reported before. Wait after installs p50 64–66 ms, with no arrivals during a hold.

##### Play during a rollover (for the next step, RESULT 12.10)
- **Exact repro, node host, creator-trusted-settlement-v1:**
  1. A Writer makes one move while the creator is sealing epoch N. One move 50 ms into the seal is enough. A move during the creator's adopt also triggers it.
  2. The creator seals, exports and adopts.
  3. The Writer installs N+1. Its settlement plan holds that move as a "rebase" entry.
  4. The install drain fails at drainSettlementOutbox, in the replacement step (v3-room ~5348), with the portable-source error above. The refusal comes from v3-live 6778, in `preparePortableSettlementSource`.
  5. The install throws, the received-adoption catch sets the terminal failure, and the Writer is terminal (deaf).
- **Reproductions:**
  - Fails 3/3 with continuous play, at head and at main.
  - The creator playing while the Writer installs is fine (6/6).
  - The scratch test is `<evidence>/track-x/data/track-x-scratch-drain-race.test.ts`, which will become the RED.
- **Which shipped pages reach it:**
  - Grid: yes (above).
  - Canvas and Chat: no. Their joiners only observe and never issue.
- **Second order, fixture only:** if the Writer installs and plays before the creator adopts, the creator's fence fails with "prospective runtime census has unresolved ingress or rebase dependencies" and the creator is terminal. No shipped harness installs before the creator adopts.
- **First read on the cause, to verify in section 13:** the dependency walk accepts only the source anchor or carriers in the census. The rebased move's parents were settled into the cut, so they are neither. The fix is either to stop the walk at vertices the successor already holds as settled, or to carry those vertices in the census. For the second order, the choice is the census rule versus the drain order.

##### State
- **Worktree:** on my branch at 23a569ac, clean apart from the untracked bench inputs (`.logs/…r8-warm-capacity-01`, never committed). The node dist is rebuilt at head.
- **Scratch branch track-x-hold-grid** (4f5fc446 plus V's 4 commits) is kept.
- **Moved to `<evidence>/track-x/data/`:** the scratch tests (hold-wait, hold-stream, drain-race), the probe patches, and the scratch Grid race harness (in `scratch-grid/`).
- **Processes:** none of mine are left running. The ports are currently held by Track Z's runs.
- **PROGRESS.md** (`<evidence>/track-x/PROGRESS.md`) is current.

### Follow-up instruction — Startup fix merged; start drain race (section 13) (2026-10-22 03:29 UTC)

Your startup order and readiness hold are merged: main is 8595826c (merge) plus docs at 30cb474e, decision rows 59-60. My verification on 44e14408 found no new per-test failures, and the REDs, bench, e2e and shipped Chat/Canvas/Grid all passed.

Next, decision row 60, in this order:

13. PLAY DURING A ROLLOVER. A Writer that moves during the creator's seal or adoption becomes terminal at its next install.
   - Base: start from main 30cb474e on your branch (`git merge` it, or `git switch -C` a new branch from it).
   - First commit the RED: the seal-time move and the adopt-time move, plus the fixture-only install-before-adopt order (the creator's census refusal), and a continuous-play case.
   - Root-cause both refusals and write RESULT section 13.
   - If the fix needs a guarantee-level or pinned-text choice, stop and bring options. Otherwise implement the smallest fix.
   - Proof:
     - the REDs green;
     - the node host with continuous play through 16+ rollovers (Writer moves every ~50-100 ms through seal, export, adopt and install);
     - your scratch Grid race harness over real networking, at least 3 runs at head, 16/16, with the creator and Writer live;
     - shipped Canvas/Chat/Grid as before;
     - the bench pairs;
     - the per-test suites against base, typecheck and the shadow guard.
   - Turn the scratch Grid race harness into a committed opt-in mode of Track V's harness (for example TRACK_V_PLAY_THROUGH_ROLLOVER=1), so continuous play can be measured from now on. Report seal/adopt/install and move delivery with play through rollovers against the paused figures.
14. D9346's MIGRATION FAILURE (line 915). Root-cause the lost target-suffix block (the 32-job input-pool refusal during a retained republication burst is your lead), with a RED if you can make it deterministic. Fix it, or bring options if it is a limit or guarantee choice. Track V's Grid switch merges after 13 and 14, so check d9346 with V's 4 commits at the end (at least 10 runs, some under load).

Parallel work:
- Track Z is wiring a scheduled lull into v3-room.ts: tail calls at the end of adoptCreatorSuccessor and installCreatorSuccessor, a runRecoveryPoolMaintenance refactor of session.maintainRecoveryPool, and a settled hook in the auto scheduler and recovery-pool-auto.ts. Avoid those spots, or tell me before you edit them.
- Track W2 is in examples/chat only.

The usual rules apply: the Node pin, per-port checks, never edit pinned or RED tests without approval, and commit only on your branch. Hand back after 14, or earlier if you need a decision.

### Report returned by the agent (2026-10-22 04:03 UTC)

Track X, row 60: I need your decision on the creator's census refusal (R3, RED case 4, fixture-only order). The Writer-side fix is green. I am carrying on with its proofs and with step 14 while you decide.

State:
- RED committed: 2863424c. All 4 cases fail at base.
- Base is main 30cb474e.

R1 (seal-time and adopt-time moves; RED cases 1 and 2), fixed:
- The Writer's install drain still prepares the portable settlement source (the walk back to the source anchor), even when the replacement is nonportable and the record is thrown away. A non-creator Writer the target authorizes has no creator selection, so its settlementAuthorization ends up undefined anyway.
- The walk needs other authors' rows of the sealed epoch. The Writer's census never holds them, so the walk throws, the install fails, and the Writer goes terminal.

R2 (found once R1 was fixed; continuous case), fixed:
- When a drain has 2 or more rebased rows, the second replacement's dependency census refuses the source the first replacement already replaced. authenticatedCompletedNativeReplacementSource needs a signed settlementSource record, and a nonportable replacement never has one. This was latent at base for any Writer with 2 or more rebase entries.

The fix for both (uncommitted):
- Only the nonportable branch of issueReplacement in v3-live changes.
- It now issues the nonportable replacement directly and skips withActiveRebaseDependencies plus preparePortableSettlementSource, whose only consumer is the portable record.
- It is behaviour-preserving whenever those steps would have succeeded. No guarantee or pinned text changes.

Results with the fix:
- RED cases 1 and 2 are green.
- The continuous case is green over 3 rollovers: 85 moves, all reach the creator. The one move per epoch that fails is the Writer's own move during its install ("not-active"), which is existing behaviour.

Harness note: the 32-job gossip queue (routeV3Ingress, MAX_ADMITTED_INPUT_JOBS) silently refused 19 of a 51-row synchronous burst. Nothing re-requests a refused tail row until a later row depends on it. That matches step 14's lead. My RED now delivers in flow-controlled batches of 16 and sends only the new epoch's rows. I'll report this in step 14.

R3 (RED case 4, install-before-adopt):
- The Writer's new-epoch row reaches the creator's new plane after activation and before its adoption drain issues its fence. The row becomes pending ingress because its dependency, the Writer's fence, was dropped by the sealed plane.
- The creator's drain issues run before readiness is prepared, so their sizing (prospectiveCreatorRuntimeCensusOverhead) requires pendingIngress.size === 0. The fence is refused and the creator goes terminal.
- Only an export before adoption can produce this. No shipped flow exports before adoption, and Writers get the successor only from that export.
- The row-51 hold begins only at readiness. Taking it at rebind in v3-room still leaves the window from activation to rebind open, so a complete fix needs the hold from activation.

Options for R3:
- (A) Ingress hold from activation. Set the readiness hold atomically when the creator's successor registration replaces its predecessor in v3PlaneRegistrations (v3-live). The room's adoption tail adopts it through publishAccepted, the drain and readiness, and releases it in a finally on every path (creator-close and v3-room).
  - Complete, no guarantee change.
  - New hold state in activation, and a G28 liveness risk if any path forgets the release.
  - Touches the adoption tail next to Track Z's spot.
- (B) Hold from rebind only (v3-room and creator-close). Greens the RED, but leaves the window from activation to rebind open, so it is partial. I don't recommend it.
- (C) Record it as a fixture-only limit (unreachable in shipped flows) and leave the code alone. RED case 4 would need your approval to be marked as a documented known limit.
- (D) Refuse, with a count, other authors' new-epoch rows at a creator successor plane until its own fence exists. A later dependent re-requests them. This changes ingress semantics.
- (E) Let the drain-time sizing count pending roots. This is a guarantee-level change to the recovery census.

I recommend C now, or A if you want R3 closed in this track.

### Follow-up instruction — Owner chose C for R3: documented known limit (2026-10-22 04:24 UTC)

The owner chose C for R3: record it as a documented known limit and leave the code alone.

What to do:
- RED case 4 is your own new test, so you may mark it as a documented known limit. Use `it.skip` (or equivalent) with a comment giving:
  - the order (export before the creator's adoption, then a Writer's new-epoch row before the creator's adoption drain);
  - why no shipped flow reaches it;
  - option A as the fix: the ingress hold from activation through the adoption tail.
- Keep cases 1-3 and the continuous case live and green.
- Record the limit in RESULT section 13. Answer one question there: can an app reach "export before adoption" through the public library API (V3RoomSession or the room package), or only through the fixture's internal path? If public API code can reach it, say so at the top of your hand-back.

Your R1/R2 fix (the nonportable branch of issueReplacement skips the portable source preparation) is fine to commit as described.

On the harness note: a burst refused by the 32-job gossip queue, with nothing re-requesting the refused tail rows, is a real-time-play issue in itself. Treat it as the core of step 14, not only as a harness concern. Then continue with the proofs and step 14 as planned.

### Follow-up instruction — Owner: evaluate an export-before-adoption API guard (2026-10-22 05:04 UTC)

I relayed your finding to the owner: an app can export before adoption through the public API (sealEpoch / serveAvailableSuccessor, exportCreatorSuccessor with no adoption precondition). They want an API guard evaluated before deciding. Without building it yet, check whether the library can refuse, or wait, to serve or export a creator's successor until the creator has adopted it, which is the order shipped flows already use. Report:
(a) every path that serves or exports successor material before adoption, and whether any legitimate flow needs it;
(b) every test, fixture, RED, frozen artifact or spec that relies on export before adoption, classified (i)/(ii)/(iii);
(c) the latency cost, if any: how long a Writer would wait for the successor in the shipped flows (it should be about zero if they already wait);
(d) the smallest guard (refuse with a typed error, or wait for adoption) and its G28 liveness argument.
Send this as a short message when you have it. Meanwhile, keep case 4 skipped as agreed and carry on with R4, the proofs and step 14.

Separately, your install-latency finding (each rebased entry pays a full dependency census in prepareReplacement, 0.4-3.5 s, so an install costs N times that) is a real-time-play problem in its own right. Measure it in the play-through proofs: install time against the number of rebased moves. Don't optimise it in this track; it will get its own track after yours merges. Do include your best read of where the per-entry cost goes.

### Follow-up instruction — Include P1 in this track if provably safe (2026-10-22 05:14 UTC)

Change of plan on P1. Installs of 64-343 s under continuous play make the play-through proof meaningless without it, so include P1 (prepareReplacement skips the dependency census for a nonportable replacement) in this track, on one condition: argue it is safe. Show that the census you skip only feeds the portable record, or is redundant for a nonportable replacement, and that every check a nonportable replacement needs (authorization, plan entry, deriveOwnedReplacement equality, G21 accounting) still runs. Write that argument in RESULT 13, list the guarantees it touches, and add a test that a nonportable replacement with a bad dependency or plan entry is still refused after P1. Commit it on its own, after the R4 fix.

If the argument doesn't hold, don't commit P1. Report why, and it goes to the follow-up track.

The remaining cost (issueOneVertex → transactIssue → nativeSignAdmission → issuanceRetirementImage encoding the whole issuance image on each issue) is the follow-up track, so don't optimise it here. Do record your profile of it in RESULT 13, including install time against the number of rebased moves with P1.

The export-before-adopt guard evaluation (a)-(d) still comes first as a short message.

### Report returned by the agent

Track X: export-before-adopt guard evaluation (a)-(d). Nothing has been built.

(a) Paths that serve or export a successor before adoption:
1. V3RoomSession.sealEpoch → serveAvailableSuccessor (v3-room ~7537). It serves straight after the close, whenever the node has a snapshot protocol host.
2. exportCreatorSuccessor (~7177) → serveSuccessor (~3427). It returns the offer and serves, with no adoption check.
3. A reopened room whose head is still pending (sealed, not yet adopted) serves at startup (~7618).
4. The storage-level subpath exports readCreatorSuccessorExport and createCreatorSuccessorMaterialServer ("@ts-drp/node/creator-adoption"). They take no session and check nothing about adoption.
Serving on its own is inert: a Writer needs the offer, and only path 2 (or 4) hands it out.
No legitimate flow needs a Writer to receive successor material before adoption. Every shipped page and harness uses the offer only after adoptCreatorSuccessor resolves. Four of them do call export before adopt (create, then adopt, then hand over): healthy-grid (and so r8), d9346, the Track V Grid harness and the Track X shipped-app harness. Two r9 tests (chat-role-network, creator-selection) fetch from the server that sealEpoch started, but only after adoption.

(b) What relies on export before adoption:
- (i) The four harnesses above: they create the offer before adopting but use it after. The row-51 proof track-x-readiness-hold-close.test.ts genuinely installs before adoption, but only through the fixture's settlementDelivery, which calls the storage-level functions directly.
- (ii) d9346 asserts the exact stage order seal, export, adopt (phase-3a1b-d9346-v3-zone.pw.ts:489-491; not a RED, but pinned). track-x-readiness-hold-red.test.ts (maintenance case) installs before adoption through settlementDelivery. My skipped case 4 does too. tests/fixtures/phase-6b-d110c-b/source-shape.mjs:38-42 pins substrings of the adoption section of v3-room.ts.
- (iii) Docs that say "seals, exports and adopts": Track V RESULT, my RESULT/README, Track K RESULT, the 06 DESIGN, and requirements-to-evidence.md:5420 ("issue/seal/export/adopt/install" seams). No spec, registry or frozen vector requires export before adoption.

(c) Latency: about zero in every shipped flow, since the Writer already gets the offer only after adoption. If export had to move after adopt, the total from seal to offer would be unchanged; the export time just moves.

(d) Guard options:
- Refuse in exportCreatorSuccessor with a typed error. This breaks the four harnesses, and reordering d9346 changes a pinned stage order (needs approval). sealEpoch's serve would also have to move to the adoption tail, where Track Z is adding its tail calls.
- Wait in exportCreatorSuccessor. This deadlocks every sequential caller: export is awaited before adopt, and both run in the same lifetime FIFO. Rejected.
- Smallest guard (recommended): gate serving, not exporting. The successor material server answers a chunk request only once the creator has adopted that successor (the adoption tail, readiness included, is complete). Before that it refuses with a typed retryable error, or holds the request, bounded by the transfer's existing per-port request limits. Effects:
  - The offer can still be created early, so no harness, pin or Track Z spot changes.
  - Nothing new is held unbounded (G21, G22).
  - A Writer can no longer finish an install before the creator's adoption tail, which closes R3 for the session API.
- Liveness: adoption is one bounded lifetime operation. Once it completes, every request is served. If it fails, the session is terminal, and the Writer's install fails the same way it would today. So the guard never leaves a Writer permanently deaf.
- Still to check: whether the Writer's install retries a refused fetch or fails, which decides between refuse and hold.
- Limits: the storage-level exports (path 4) stay unguarded unless the gate goes into createCreatorSuccessorMaterialServer. Doing that would remove the row-51 proof scenario (readiness-hold-close/red).
- Note: in the spec, G28 is "native requirements need native evidence". The liveness argument above falls under G2/G3 and the brief's "never permanently deaf".

Separately, a new finding I'm characterising now (R5, likely a guarantee-level choice). With paced play-through (one Writer move per seal), the Writer's 9th install fails "journal retirement refused: malformed-input", and the Writer goes terminal.
- Cause: each epoch's Writer journal scope that holds a move outside the cut (later replaced nonportably) is never collectible. The closed-membership prefix needs every row in the cut, and the local-issued path needs every row covered-historical.
- So the protected scopes grow by one per epoch (0..7). At 8 they exceed maxScopes (7), and prepareFence refuses.
- This is also unbounded growth with room age (G1).
I'll send options shortly. P1 is next after that.

### Report returned by the agent

Track X R5 needs a decision: a Writer that moves during 8 seals goes terminal.

What I see: with one Writer move during each seal (node host, paced play, R1/R2/R4 fixes in), the Writer's install of epoch 9 fails with "journal retirement refused: malformed-input". The Writer is then dead.

Root cause (probe evidence: logs r60-r5-probe-r1..r3):
- A Writer's journal for epoch e can be collected only as a closed-membership prefix. creator-closed-rollback-data.ts prepareClosedJournalMembershipPrefix requires the scope's rows to equal the signed cut's membership exactly (`frames.length !== members.size` → undefined).
- The local-issued fallback refuses any scope that also holds received rows (closedJournalScopeHasNonLocalRows → "unclassified-prefix").
- A move the Writer made after the creator's cut sits in the epoch-e journal, outside the cut, and is replaced in e+1. So that whole scope is retained forever. Once protected, it stays protected in every later intent.
- Writer protected scopes by epoch: [0,1,2] → [0..3] → … → [0..7]. At 8 they exceed LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes (7), and the live-journal prepareFence refuses (captureJournalRetirementPreparation).
- So a Writer that ever moves during 8 seals, over the room's whole life, dies at its next install. It is also unbounded growth with room age (G1).
- The creator is unaffected: it drains normally.
- The cause is the membership rule, not the profile, so I expect it on any profile where a Writer's row falls outside a cut. Not yet checked on shipped Canvas/Chat, whose long-room harnesses pause during rollovers.

Options:
- A (my recommendation): one more collectible class.
  - An epoch-e scope whose rows are exactly cut(e)'s membership, plus local-issued rows outside the cut.
  - Each outside row must be a source this author replaced, and the replacement must be a member of a later signed cut.
  - Binding: deriveOwnedReplacement(source vertex, immutable policy) equals the replacement's operations, as R4's completedNonportableReplacementChunk already checks.
  - Deletion proof is then signed facts only: the two cuts, both signed vertices and the policy. Plan labels and counts are not proof (G7, G8, G10).
  - Touches G7, G8, G10, G15 and G19, and needs your approval.
  - Cost: one bounded check per outside row, in the existing pass.
- B: the same as A, but the replacement only needs to be durably issued and published, not yet in a signed cut.
  - Collects one epoch sooner, but rests on local evidence. I don't recommend it (G5, G8).
- C: no code change. Document it as a limit: a Writer must not move during more than 7 seals.
  - Real-time play makes that unavoidable, so it isn't acceptable for the Grid.
- D: raise maxScopes.
  - Only moves the wall, and still breaks G1. Rejected.

Until you decide, I'm continuing with P1 (with the safety argument and its refusal test) and step 14. The 16-rollover play-through proofs can't pass before R5 is fixed: both the node host and the Grid will die at the 9th install.

### Follow-up instruction — Owner decisions: gate serving, R5 option A (2026-10-22 05:32 UTC)

Owner decisions on the guard and R5 (the owner chose both directly, 2026-10-22).

1. Guard: gate serving, not exporting (your recommended option). The offer can still be created before adoption. The successor material server answers chunk requests only after the creator's adoption tail, readiness included, has completed. Pick hold or typed retryable refusal by what the Writer's install does with a refused fetch: if it doesn't retry, hold, bounded by the existing per-port request limits. The rule is that the gate must never be the reason a Writer's install fails. Leave the storage-level subpath exports (createCreatorSuccessorMaterialServer, readCreatorSuccessorExport) unguarded, so the row-51 proof scenario stays, and record them as a known limit. RED first: a Writer that fetches before adoption is not served until adoption completes, then installs. Un-skip your case 4 only if it now passes as written; otherwise leave it skipped and say why.

2. R5: option A, prove by signed cut. The new collectible class is an epoch-e scope whose rows are exactly cut(e)'s membership plus local-issued rows outside the cut. Each outside row must be a source this author replaced, the replacement must be a member of a later signed cut, and deriveOwnedReplacement(source vertex, immutable policy) must equal the replacement's operations. Deletion rests on signed facts only. RED first, plus refusal tests showing the scope is still retained when:
   (a) the replacement is not yet in a signed cut;
   (b) the replacement's operations don't match the derivation;
   (c) the outside row isn't local-issued;
   (d) the outside row isn't a replaced source.
   Show that the Writer's protected scopes stay bounded over at least 16 rollovers of paced play (node host). In RESULT, state per guarantee (G7, G8, G10, G15, G19) why it still holds. Also check whether R5 is reachable on shipped Chat now that Track W2 adds late Writers, and say so either way.

Order: R5 (it blocks every play-through proof), then the gate, then P1 under its existing condition, then step 14 and the proofs.
