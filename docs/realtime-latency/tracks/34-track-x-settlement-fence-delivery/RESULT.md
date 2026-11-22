# Track X: successor delivery and durable settlement completion

Original investigation: <worktree agent-a9ab847b594d95e7f>/, branch worktree-agent-a9ab847b594d95e7f.
Continuation integrated on codex/phase3a1b-p6-golden-path: F1 177f4355, native point read 9b41a0e4, F2/Done fd342d90, sealed recovery 7c94ec35.
Evidence: <evidence>/track-x/ (PROGRESS.md, logs/, tests/, bench/, bin/, data/, trash/).

On the `creator-trusted-settlement-v1` profile, with real networking in Chromium, the creator's moves stopped reaching
the other peer after the fourth successor (Track V, Grid). Track X found the cause, fixed it in the library, and looked
at Track V's two d9346 failures.

## Current delivery status

The delivery, serving-gate and migration-prime fixes below are integrated. The final continuation also implements
transferred Cut membership (F1), durable received authority (F2), and one local settlement-completion rule. Section 18
records that result and its evidence. Earlier sections preserve the original measurements and their source revisions;
their historical open-item lists do not describe the final continuation.

## Initial delivery result

- **Step 1: shipped Canvas and shipped Chat on main stall the same way** (section 1). Both stop at epoch 5 in every
  run, with Track V's signature. Legacy Canvas passes 16/16. The stall also happens with Track Q merged.
- **The bug is older than the latency work.** Shipped Chat at 3c5bb123, the parent of the effort's first commit,
  stalls at epoch 5 in 2/2 runs (section 2.6).
- **Root cause** (section 2). The creator publishes its settlement author fence at adoption, so it reaches the
  recipient while the recipient is still on the old epoch. The recipient cannot authenticate it there and drops it.
  Its install asks for nothing. The creator's next move then waits in pending ingress for the fence, and nothing asks
  for the fence. Only the retained-history requests scheduled once at session open (0 to 15 s after open) repaired
  epochs 2 to 4. The first epoch after that schedule ran out was never repaired. Every later creator move depends on it,
  so it is lost, not delayed.
- **The fix** (section 4, commit 24699ced): a recipient that holds a fully authenticated vertex with a missing
  dependency asks the creator for retained history, at most once a second per room; and a recipient asks once right
  after each install. No vertex is admitted any earlier, nothing new is held, and the room never stops asking while it
  waits.
- **Proof** (section 5). The RED tests pass. Chromium, every run 16/16 epochs: Grid with Track V's switch 3 runs plus
  the 5 s pause variant; Canvas 2 runs plus pause; Chat 2 runs plus pause. The creator's first move of each epoch now
  reaches the recipient in 6 to 203 ms (base: 1.9 to 3.9 s, then never). Storage is flat from epoch 7. The latency
  bench (8 rollovers, 4 interleaved base/fix pairs) is unchanged.
- **Track V's d9346 failures** (section 6):
  - Line 908 (migrated joiner, `issuance retirement plan has no lineage`): a library defect. The census law refused a
    plan that the room itself writes. Fixed in f4c3c5c2 (RED 3e806aff). With it the migration test passes 3/3.
  - Line 474 (a finishing resource program built during the first placement): the placement builds nothing itself.
    It waits for the creator's startup readiness, which on settlement cannot finish until the first peer subscribes to
    the room topic. This is lawful but costs the first placement after a join up to about 1.5 s. It needs an owner
    decision (section 6.1). I did not change it, and I did not edit the test.
- **Suites, typecheck** (section 7). Per test, base against fix: no new failure in any set; the 8 Track X tests are
  the only change (failing at base, passing with the fixes). Canvas and Chat e2e pass 9/9 on both sides. The workspace
  typecheck has 0 errors, and the shadowed-sources check is clean.
- **The Canvas harness hang** (section 9, merge verification): a seal deadlocked on its own live journal. The
  close took a journal source (a held IndexedDB read view) before staging the snapshot, and the stage waited for an
  admitted ingress append that waited for the view. The bug predates Track X's fix.
- **The seal deadlock fix** (section 10, commit 2a65f450, RED e1f471bb; coordinator decision, row 49): `close()`
  stages the snapshot before it takes the promotion or recovery source. The RED hangs 4 of 4 at base, on the default
  and the room-database host, and passes with the fix. The storm harness has 0 hangs in 31 runs (base: 2 of 30).
  Canvas, Chat and Grid run 16/16. The fix also removes Track M's `NATIVE_READ_RESERVATION_BUSY` seal race (base 13 of
  16 fail with no settle before the seal, fix 0). It departs from row 49 in one point: after a source failure the
  epoch stays folded and the close stays retryable, because `abortSnapshotStage` cannot undo a fold (10.2).
- **The startup order** (section 11, row 45): options only, nothing implemented. A scratch prototype (readiness
  before publication on settlement) makes the startup RED and d9346 pass (9/9 runs with the seal fix), but it changes
  the order pinned in `creator-ordinary-readiness-producer.test.ts`, and it exposes an intermittent
  `NATIVE_READ_RESERVATION_BUSY`: a received append that meets the readiness job's held read view is dropped, not
  retained. Every option that prepares readiness earlier needs that fixed too.

## 1. Step 1: shipped Canvas and Chat on main

Harness: tests/track-x-shipped-app-long-room.pw.ts with playwright.track-x-shipped-app-long-room.config.ts (commit
4122ab83). It serves the shipped pages exactly as playwright.canvas-chat.config.ts does: pages on 4180 and 4181,
network fixtures on 4175, relays on 51000 and 51002, real libp2p gossip and direct streams. Each peer has its own
account floor. Each epoch the creator makes 2 moves through the UI, and the harness waits up to 60 s for each to show on
the recipient's page. Then the creator seals, exports and adopts, and the recipient installs. Neither page can enroll a
Writer, so the recipient is an observer (receive-only). Neither page rolls the room over by itself, so the harness
does, through a test-only room handle it appends to the served /src/index.ts.

| App    | Commit          | Profile                       | Runs           | Result                                 |
| ------ | --------------- | ----------------------------- | -------------- | -------------------------------------- |
| Canvas | 5ed93b67        | creator-trusted-settlement-v1 | c1, p2 (probe) | stuck at epoch 5, creator's first move |
| Chat   | 5ed93b67        | creator-trusted-settlement-v1 | c1, p2 (probe) | stuck at epoch 5, creator's first move |
| Canvas | b2c3d8f1        | creator-trusted-v1 (legacy)   | c1, c2         | 16/16, 16/16                           |
| Canvas | 6b9e27cc (Q in) | creator-trusted-settlement-v1 | q-c1           | stuck at epoch 5                       |
| Chat   | 6b9e27cc (Q in) | creator-trusted-settlement-v1 | q-c1           | stuck at epoch 5                       |

Logs: <evidence>/track-x/logs/{canvas,chat}-main-{c1,p2}.log, canvas-b2c3-{c1,c2}.log, {canvas,chat}-q-c1.log.

Signature, the same as Track V's Grid: every epoch the recipient logs `::v3-ingress not-authenticated` while the
creator adopts, then `::v3-ingress graph-rejected` at the creator's first move of the next epoch. In epochs 2 to 4 that
first move shows on the recipient 1.9 to 3.9 s after it is issued (the second move takes 4 to 130 ms). With the probe,
a later creator move also arrives and is held. On legacy every move shows in 7 to 140 ms and no ingress line appears.

## 2. Root cause

Traced with temporary instrumentation on shipped Chat (<evidence>/track-x/logs/chat-trace-t1.log; the instrumentation
was removed, its patch is data/trace-instrumentation.patch). Line numbers are at 24699ced.

### 2.1 One rollover, on the recipient

1. **The creator publishes its fence before the recipient can read it.** Creator adoption ends with
   `if (!input.receiveOnly && settlementProfile === "v1") { await publishAccepted(); await drainRebaseOutbox(); }`
   (packages/node/src/v3-room.ts:6663, in `performCreatorSuccessorAdoption`). That gossips the settlement author fence
   (`$drp.author-fence.v1`), anchored in the successor. The recipient is still on the old epoch, so
   `authenticateV3Ingress` (packages/node/src/v3-live.ts:7909) fails it as `not-authenticated` and returns: the vertex
   is dropped, not held.
2. **Install asks for nothing.** Before the fix, neither `installCreatorSuccessor` nor the adoption it runs requested
   retained history. Copies that arrive during the install meet the closing plane and are dropped (`enqueueV3Ingress`,
   v3-live.ts:8170).
3. **The creator's next move waits for a dependency nobody asks for.** It authenticates, its dependency (the fence) is
   missing, so `retainPendingIngress` (v3-live.ts:7435) holds it and logs `graph-rejected`. `drainPendingIngress`
   (v3-live.ts:7458) runs only after a later successful admission, which needs the fence.

### 2.2 Why epochs 2 to 4 recover and epoch 5 never does

The only thing that ever brought the fence back was the retained-history schedule each session starts once at open
(`openedTransport.requestRetainedHistory()`, v3-room.ts:4245). The room network fires it at open + 0, 0.5, 1.5, 3, 6,
10 and 15 s (`RETAINED_REQUEST_DELAYS`, packages/node/src/room-network.ts:16; `#scheduleRequests`, room-network.ts:717).
Each tick sends HISTORY_REQUEST to the creator and makes the creator republish its retained journal to the recipient
(`#performRequest`, room-network.ts:777).

In the trace the creator opened at 4.76 s and the recipient at 5.05 s. On the creator the same schedule republishes its
journal by gossip, at 4.9, 6.0, 6.4, 7.9, 10.9, 14.9 and 19.9 s; the recipient's requests went out at 5.3, 6.6, 8.1,
11.1, 15.1 and 20.1 s. Epoch 2's held move was repaired by the creator's +6 s tick (10.9 s), epoch 3's by the +10 s
tick (14.9 s), epoch 4's by the +15 s tick (19.9 s). Epoch 5's first move was held at 24.2 s, after the last tick. It
was never repaired.

So the stall follows the tick count, not the clock. The first four ticks pass during the join and epoch 1. Each of the
last three repairs one epoch. That is why it is always epoch 5 when epochs are shorter than the tick spacing, and why
Track V's 5 s pause after each install moved it to epoch 4. The page time of the stall is open + 15 s plus the wait for
the next epoch's first move: 20 to 28 s in my Canvas and Chat runs, 33 to 41 s in Track V's Grid runs, whose epochs are
slower. The 1 to 4 s delivery delays in epochs 2 to 4 are the gaps to the next tick.

### 2.3 Why later creator moves are lost, not delayed

Every later creator vertex depends, directly or through its predecessors, on the missing fence. Each is held in
pending ingress, which is bounded (`maxPendingEntries`, `maxPendingBytes`); once that is full, new arrivals are refused
with `graph-rejected`. No schedule remains, the install schedules nothing, and the creator republishes only on
request. So nothing ever brings the fence, and the held moves are never admitted.

### 2.4 Why the 4th install is the first slow one

In every run, on both profiles, the install to epoch 4 is the first slow one (0.9 to 2.3 s against 0.13 to 0.29 s).
That is the recipient's first received recovery turnover. In packages/node/src/creator-adoption.ts:885,
`receivedRecoveryTurnoverDue` is false before epoch 2 and becomes true once the recipient's recovery pool is full or a
classified scope is present; the trace shows `install-turnover true` first at the install to epoch 4. It is bounded
maintenance that legacy does too. It sits just before the stall but does not cause it: with the fix the 4th install is
still the first slow one (Grid 1.0 to 1.6 s) and nothing stalls.

### 2.5 Why the latency bench does not stall

The bench (tests/fixtures/startup-discovery/healthy-grid.ts, settlement, 100 rollovers) differs from the shipped pages
in exactly the place that matters:

- It does not use the room network. Its transport is the warm worker transport
  (.logs/bounded-storage-lifecycle/r8-warm-capacity-01/worker-transport.ts), over postMessage.
- After every rollover it runs `history` on all four roles (healthy-grid.ts:553) before any gameplay. That is
  `synchronizeRetainedHistory()` (healthy-grid.ts:224): a strict, awaited request for retained history from every
  connected peer. It fetches the dropped fence every time. The shipped pages have no such step.
- It waits for each move's admission on every peer before the next one.

Track V's section 6.1 lists further composition differences; they do not matter for this bug.

### 2.6 How old the bug is

Shipped Chat at 3c5bb123 (the parent of 4c4f192c, the first commit of the latency effort) stalls at epoch 5 in 2/2 runs
of 6 epochs, with the same signature: 4 `not-authenticated` and 4 `graph-rejected` lines on the recipient, first-move
delivery 0.4 to 1.9 s in epochs 2 to 4, and the 4th install the first slow one (2.4 to 3.1 s). So the bug predates this
work, and no bisect inside 3c5bb123..5ed93b67 was needed. Logs: <evidence>/track-x/logs/bisect-3c5bb123-r{1,2}.log,
bisect.log. At 3c5bb123 `pnpm build:packages` fails in test-utils (a typecheck error fixed later), so the bisect built
only the Chat page's dependency closure, storage-node and the relays.

## 3. RED tests (committed before the fixes)

- **7cbbcaef**, tests/track-x-settlement-fence-delivery-red.test.ts with tests/fixtures/track-x/fence-delivery-room.ts.
  Track S's composition (Grid zone application, settlement, latched ACL v3, SQLite host), with the genuine
  `NodeRoomNetworkAdapter` over a two-peer in-memory network: gossip copies, and direct sends that carry
  authenticated-stream evidence, routed as `DRPNode.dispatchMessage` routes. The test waits 16 s so the open-time
  schedule runs out, then runs 4 rollovers in the shipped order and asserts that each fence was delivered while the
  recipient was still on the old epoch. Writer and observer variants. Base: both fail "epoch 1 creator move 0: not
  admitted", with exactly 1 `not-authenticated` and 1 `graph-rejected` (logs/red-base.log). Without the wait, epochs 1
  to 5 are repaired by the open-time ticks and epoch 6 stalls, the browser signature (logs/red-base-settle0.log).
- **d48b57cd**, second case: a creator move lost in transit, then the creator's next move that needs it. Base never
  admits it, already in the genesis epoch (logs/red-base-2.log).
- **3e806aff**, tests/track-x-inherited-plan-census-red.test.ts, for the d9346 migration failure (section 6.2). Base
  fails with exactly the shipped error (logs/census-red-base.log).

## 4. The fix (24699ced)

### 4.1 What changed

| File                                               | Function or member                                                                                                                                                                          | Change                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/node/src/v3-live.ts                       | `authenticateV3Ingress`                                                                                                                                                                     | After `retainPendingIngress` holds a fully authenticated vertex with a missing dependency, call `requestMissingDependencies`.                                                                                                                  |
| packages/node/src/v3-live.ts                       | `bindV3MissingDependencyRequest` (new, exported), `requestMissingDependencies` (new), `v3MissingDependencyRequests` (new)                                                                   | A per-network-node, per-topic binding from the live plane to its room's request callback. The call runs only for the current registration and swallows a throwing callback.                                                                    |
| packages/node/src/room-network.ts                  | `NodeRoomNetworkPort.requestMissingRetainedHistory` (new), `#requestMissing` (new), `RoomRegistration` (2 fields), `close`, `MISSING_HISTORY_REQUEST_INTERVAL_MS` (new)                     | One immediate request through the existing coalesced `#request`, then at most one trailing request a second later if more were asked for. One timer per room, in the room's timer set, cleared at close. No-op on the creator and after close. |
| packages/node/src/v3-room.ts                       | `V3RoomTransport.requestMissingRetainedHistory?` (new, optional), session helper `requestMissingRetainedHistory` (new), `revokeTransport`, ingress handler setup, `installCreatorSuccessor` | Bind the plane to the transport's request when the transport has one, unbind when the transport is revoked, and ask once after a successful install. The helper is a no-op once the session is closed or its transport is closing.             |
| tests/track-x-room-network-missing-request.test.ts | new                                                                                                                                                                                         | Fake timers: 1000 calls send 1 immediate request and 1 trailing one; close cancels the trailing one; the creator does nothing; the open-time schedule is unchanged.                                                                            |

Ablations on the RED tests: the on-demand trigger alone passes both; the install-time request alone passes the first
and fails the second (logs/red2-ablation-install-only.log). So the on-demand trigger is the necessary part; the
install-time request only saves the first move of each epoch its wait.

### 4.2 Why it keeps G1-G28

- **Authentication (G5).** Nothing is admitted earlier or by another path. The request fires only after a vertex has
  passed every authentication step and been held. The answer is the creator's existing retained republish, which
  arrives on the existing retained route and goes through `authenticateV3Ingress` again from the start. A fence
  that failed authentication is still dropped; it is fetched again, never admitted on the strength of the request.
- **Bounded and counted (G21, G22).** No new holding: pending ingress keeps its existing bounds and census counts.
  Requests per room are at most one a second plus the existing coalescing (one in flight, one pending). There is one
  timer per room, owned by the room's timer set. The creator's answer is its existing bounded retained republish.
- **No resurrection by delayed callbacks (G4, G17).** The trailing timer is cleared at close; the binding is removed
  when the transport is revoked; the plane calls only while it is the current registration; the session helper is a
  no-op once closed or closing.
- **FIFO ingress at lulls (G23).** The answer enters through the same `enqueueV3Ingress` queue as any retained input.
- **Never permanently deaf.** Each held arrival asks again, not a schedule that can run out. The creator asks no one;
  its journal is the authority for its epoch.
- **Latency never relaxes safety; no game carve-outs (G26, G27).** The change is in the library, for every app, and
  nothing in examples/ changed.
- **Golden path (G3).** Section 5.

## 5. Proof

### 5.1 RED

7cbbcaef and d48b57cd pass with the fix (logs/red-fix-1.log, red2-fix.log); 3e806aff passes with f4c3c5c2
(logs/census-red-fix.log).

### 5.2 Chromium

Node dist rebuilt with the fix before every run. Grid runs use Track V's harness (tests/track-v-grid-long-room.pw.ts) on
the scratch branch track-x-grid-switch: 24699ced plus Track V's switch 15bf2ed1 cherry-picked (9f9c9685). "Delivery"
is the creator's first move of each epoch, issue to display on the recipient.

| App and run     | Epochs     | Recipient ingress per epoch               | Notes                                                                     |
| --------------- | ---------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| Grid g1, g2, g3 | 16/16 each | 1 `not-authenticated`, 0 `graph-rejected` | Writer recipient. Creator issue median 139 to 177 ms, Writer 23 to 27 ms. |
| Grid pause5     | 16/16      | same                                      | 5 s pause after each install (without the fix: stuck at epoch 4).         |
| Canvas c1, c2   | 16/16 each | same                                      | delivery 13 to 155 ms                                                     |
| Canvas pause5   | 16/16      | same                                      |                                                                           |
| Chat c1, c2     | 16/16 each | same                                      | delivery 6 to 60 ms, one 203 ms                                           |
| Chat pause5     | 16/16      | same                                      |                                                                           |

The one `not-authenticated` per epoch is the fence that still arrives before the install; it is now fetched again at
install. Logs: <evidence>/track-x/logs/grid-fix-{g1,g2,g3,pause5}.log, canvas-fix-{c1,c2,pause5}.log,
chat-fix-{c1,c2,pause5}.log; summaries: `node bin/summarize-grid.mjs` and `node bin/summarize.mjs`.

From epoch 5 on, the creator's seal takes 3 to 9 s in Canvas, Chat and Grid. That is the creator's settlement
maintenance; base never got past epoch 4 on these pages, so there is no browser base to compare. The fix touches no
seal path, and the bench's seal medians are unchanged (5.3).

### 5.3 Latency bench

tests/fixtures/startup-discovery healthy Grid bench, 8 rollovers, default environment, 4 interleaved base/fix pairs
(ABBA twice), loads 43 to 115. All 8 runs pass. Pooled medians over transitions 3 and later:

| Side | Seal ms | Adoption ms | Install ms | Issue ms | Delivery ms |
| ---- | ------- | ----------- | ---------- | -------- | ----------- |
| base | 3481    | 685         | 2237       | 54.7     | 120         |
| fix  | 3412    | 695         | 1971       | 51.7     | 118         |

Per-pair signs alternate, so this is unchanged. The bench's worker transport has no `requestMissingRetainedHistory`,
so the binding is skipped there by construction; the census change only touches lineage-less plans, which the bench
never writes. <evidence>/track-x/bench/summary.txt, summary-from-t0.txt, runs/index.txt.

### 5.4 Storage

Flat from epoch 7 in every browser run: Grid creator 169 rows / 13 issued, Writer 148 / 13 (pause run 170 / 13,
149 / 13); Canvas and Chat creator 160 / 13, observer 111 / 0.

## 6. Track V's d9346 failures, with Track V's switch on top

tests/phase-3a1b-d9346-v3-zone.pw.ts with playwright.phase-3a1b-d9346-zone.config.ts, on track-x-grid-switch.

| Run                  | Library                     | Placement test (line 474) | Migration test (line 908) |
| -------------------- | --------------------------- | ------------------------- | ------------------------- |
| d9346-fix-r1         | delivery fix                | fail                      | fail: no lineage          |
| d9346-censusfix-r1   | delivery fix and census fix | not run                   | pass                      |
| d9346-bothfix-r1, r2 | delivery fix and census fix | fail, fail                | pass, pass                |

### 6.1 Line 474: a finishing resource program during the first placement

The test records `ordinary-finishing-resource-program-build` events and requires none inside the creator's first
measured `placeBlock`. The event inside it has phase `boundary-preparation`, which only the explicit startup readiness
preparation emits; the placement's own issue is an `ordinary-incremental-hit` (data/d9346-fix-r1-evidence.json).

A scratch copy of the spec (never committed; trash/d9346-scratch) logged the creator's clock. In one run: zone created
at 2.50 s and ready at 2.69 s; the Writer's join admitted at 4.34 s and converged at 5.48 s; the placement started at
5.81 s; the readiness build ran at 7.08 s and readiness was prepared at 7.12 s; the placement's own issue hit the warm
path at 7.30 s; the placement ended at 7.33 s (logs/d9346-wait0b.log). With a 3 s wait before the placement, readiness
lands before it and the whole test passes, rollover included (logs/d9346-wait3000.log).

Why readiness is that late on settlement: the creator's startup barrier (`rebasePromise`, v3-room.ts:5705) runs
`waitForRetainedBootstrap`, `publishAccepted`, `drainRebaseOutbox` and only then `prepareCurrentCreatorOrdinaryReadiness`.
`publishAccepted` publishes through `DRPNetworkNode.publishMessage`, which waits for a subscriber on the topic
(`waitForPeersAndPublish` and `waitForSubscriber`, packages/network/src/node.ts:2819-2822). So the creator's readiness
cannot finish until the first peer joins. Just before the build the creator logs
`ordinary-source-native-control-mismatch` (a native control appeared), which fits the settlement drain's writes. The
placement awaits the same barrier. On legacy the barrier skips the publish and the drain at genesis and prepares
readiness at open.

So the placement builds nothing on its own. The cost is real, though: the first creator placement soon after the first
join waits up to about 1.5 s here. Options for the owner:

1. Accept it as a settlement startup cost and amend the d9346 assertion to exclude startup boundary preparation (needs
   owner approval; I did not edit the test).
2. Change the startup order in the library so readiness does not wait for a subscriber: do the local settlement drain
   first, prepare readiness, and publish when a peer arrives. That changes when the genesis fence is published.
3. Leave it.

### 6.2 Line 908: `issuance retirement plan has no lineage` (fixed)

A dump of the joiner's IndexedDB at the failure (data/d9346-joiner-idb.json) shows, in its migration-target issuance
database, one settlement plan for the joiner: one `inherited` entry (its source sequence 2, the `rejoined` block that
the creator imported at target sequence 3), `fenceSequence` null, revision 0, and no lineage, issued or outbox row.

The joiner's target session writes that plan (`mergedSettlementPlan`, v3-room.ts:4854, via
`writeMergedSettlementPlan` in `drainSettlementOutbox`) and only then issues its first target fence, which creates its
lineage. The store accepts the write. But the bounded recovery census (`issuanceRetirementImage`,
packages/issuance-store/src/retirement.ts:1426) refused any plan without a lineage unless every entry names an external
source in `sourceObjectId`. An inherited entry keeps its source in `inheritance` instead, so the census refused it, the
joiner's target session failed, and the joiner could never open the zone. Legacy writes no settlement plan, which is
why base passed.

The fix (f4c3c5c2) lets the no-lineage exemption also admit inherited entries, under the same conditions (no fence yet,
at least one entry, no replacement) and only when the inheritance targets this object from another object. The
per-entry inheritance check after it is unchanged. The RED test pins that a lineage-less plan with a local source, a
fence, no entries, or an inheritance into another object is still refused. Under G5, G21 and G22: the census still
classifies and charges every row, and an inherited entry grants neither admission nor completion.

Once in six migration runs (a scratch run, logs/d9346-migrate-dump.log) the reopened joiner's `rejoined` block did not
reach the creator (line 881). The reopened joiner logged direct-stream send timeouts and rejections, and the creator
logged no ingress line at all, so that was a link failure, not a held dependency. I did not investigate it further.

## 7. Suites, typecheck

Vitest from the repository root with `--exclude ".claude/**" --no-coverage`. Fix is the branch head (24699ced and
f4c3c5c2). Base is the same tree with the four library files at main 725f291b (room-network.ts, v3-live.ts, v3-room.ts,
retirement.ts) and the node and issuance-store dist rebuilt from them (bin/swap.sh); the tests are the same on both
sides. Reports: <evidence>/track-x/tests/{base,fix}-<set>.json; comparison: `python3 bin/vcompare.py`.

| Set                                                                                    | Base                            | Fix                             | New failures | Fixed |
| -------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------- | ------------ | ----- |
| node: packages/node                                                                    | 1023 pass, 48 fail              | identical                       | 0            | 0     |
| snr: the 7 storage-node retirement and retention files                                 | 163 pass, 61 fail, 2 skipped    | identical                       | 0            | 0     |
| native6: Canvas and Chat native tests, with Track M's Chat catalog                     | 35 pass, 15 fail                | identical                       | 0            | 0     |
| obs: the three startup-discovery observation tests                                     | 23/23                           | 23/23                           | 0            | 0     |
| grid: examples/grid/src and the e4-01 and e4-03 REDs                                   | 65/65                           | 65/65                           | 0            | 0     |
| root: 123 files (Track V's root set, Tracks K, L, N, P, M, O, M2, S, T, Q and Track X) | 812 pass, 366 fail, 110 skipped | 820 pass, 358 fail, 110 skipped | 0            | 8     |
| Canvas and Chat e2e (playwright.canvas-chat.config.ts)                                 | 9/9                             | 9/9                             | -            | -     |

- The 8 fixed are the Track X tests: the four fence-delivery REDs, the three missing-request bounds tests and the
  census RED. The base failures are the same tests on both sides: pre-existing REDs (for example
  phase-6b-d110c-0c1f5b0c-room-red 25, phase-6b-d110c-0c1f5b-integration-red 22, phase-3g-v3-room-rebase-red 18), and
  in snr a schema version 5 where tests expect 3 and a missing SQLite function.
- Files that do not load on either side: tests/protected-recovery-role-node-red.test.ts (frozen artifacts required),
  tests/r11-real-game-terminal-native.test.ts (`@ts-drp/storage-node/room-head`), tests/r9-rpc-v3-room-native.test.ts
  (`@grpc/grpc-js`), packages/node/tests/creator-ordinary-generation-closure-capacity.test.ts and
  packages/node/tests/proptest/spawn-scaling.test.ts (`@ts-drp/object`).
- The pre-existing tests/r9-room-network-repair-admission.test.ts failure ("room network is already active") fails on
  both sides.
- `pnpm -r typecheck`: 0 errors, 46 of 47 projects (logs/typecheck-fix.log). The root tests are in no typechecked
  project. Under an ad hoc root config (data/tsconfig.track-x-tests.json) the new test files show only the errors the
  files they follow show too: the Track M fixture's session-input type and `@ts-drp/network` resolution, and the
  extensionless fixture import every Grid Playwright spec uses.
- ESLint: the three node files have the same counts before and after (2766); the new lines in retirement.ts and the
  new test files have no findings. Prettier was run on the new files (the four library files were not
  Prettier-clean before and were not reformatted).
- `node scripts/check-shadowed-sources.mjs`: clean. No process of mine was left running, and no port was left held.

## 8. What remains, and risks

- **Creator-side gaps are not re-requested.** The creator asks no one. If a Writer's vertex reaches the creator before
  something it depends on, or is lost, the creator still relies on the Writer's open-time schedule and on the Writer's
  own requests, which republish the Writer's journal to the creator. I saw no such case.
- **A recipient asks only the creator.** That matches the room network's existing request (HISTORY_REQUEST goes to the
  creator). A creator that is offline cannot answer, as before.
- **No periodic retry.** If the answer to a request is lost and the creator sends nothing new, the held move waits
  until the creator's next move or the next install. Each new arrival with a missing dependency asks again.
- **Request amplification** is bounded at one request a second per room, plus one at each install.
- **The bench does not exercise the new path**, because its transport has no `requestMissingRetainedHistory`.
- **d9346 line 474** needs the owner's decision (section 6.1).
- **Track V's switch is not merged.** These Grid proofs use it on a scratch branch only.

## 9. The Canvas harness hang (merge verification, 2026-10-21)

The coordinator's merge check ran the Canvas harness once and the creator's epoch-3 rollover never returned (30 minute
test timeout; <evidence>/verify-x/). It is not caused by the Track X fix. It is a deadlock in the creator seal that
base 725f291b has too.

### 9.1 The deadlock

`close()` in packages/node/src/creator-close.ts takes the promotion or recovery source (3730, and 3740-3746 when
`epoch >= 2`) before it stages the snapshot (3748). Taking the source reaches `acquireClosedData` in
packages/node/src/internal/creator-closed-rollback-data.ts (7268-7271: `acquireJournalHeaderHold`), which holds the
live journal's native read reservation: a readonly IndexedDB transaction on acceptedEntries, retirementControls and
scopes that stays open (`HeldReadView`, packages/storage-browser/src/internal/native-read-reservation.ts) and, by
design, excludes every native writer (live-journal.ts 961-962, 1662). It also takes two shared
snapshot-recovery-dependency locks. All of this happens outside the live plane's FIFO. Then `stageSnapshot` reaches
`stageBlueprintEpoch` in v3-live.ts, which sets `blueprintClosing` and waits for the FIFO's earlier tasks
(`enqueueRegistrationTask`), still holding the view.

An ingress task that started before `blueprintClosing` was set is one of those earlier tasks. Ingress of a vertex the
creator already has still calls `liveJournalStore.appendAccepted` and expects an idempotent result
(`handleV3IngressWithSource`). That append opens a readwrite transaction on the same stores, and IndexedDB starts it
only after the earlier readonly view ends. The view ends only when the seal releases its source, after the stage. So
the stage waits for the FIFO, the FIFO waits for the append, the append waits for the view, and the view waits for the
stage. Nothing in the chain has a timeout. Any ingress append that starts in that window closes the cycle: the
recipient's push of its own retained rows to the creator (`#performRequest` in room-network.ts sends them with every
history request), or a Writer's new move.

Evidence, with the harness's IndexedDB and Web Locks probe (`TRACK_X_IDB_PROBE=1`): in every hang the creator's step
is `seal`, no network call is in flight, and the creator page has a readonly `HeldReadView` transaction on
drp-live-journal-v1 created at the seal's start, the two shared snapshot-recovery-dependency locks from the same
moment, and a readwrite `appendWriter` transaction on the same stores created 15 to 80 ms later, all still open after
90 to 180 s. Every hang is at harness epoch 3, the first seal with `epoch >= 2`. Every hang starts within about 40 ms
of a recipient history request from the schedule the room network starts when the recipient opens (+6 s four times,
+10 s once; RETAINED_REQUEST_DELAYS). The coordinator's run matches too: the recipient joined at trace 12.25 s and the
seal started at 18.32 s.

### 9.2 Base and head

Fast Canvas runs, 4 epochs, `TRACK_X_HISTORY_STORM_MS=250` (the recipient sends the creator a direct history request
every 250 ms, which makes the hang far more frequent):

| Library                                  | Runs | Hangs | Where                                             |
| ---------------------------------------- | ---- | ----- | ------------------------------------------------- |
| base 725f291b                            | 30   | 2     | epoch-3 seal, same IndexedDB pattern              |
| 9b6b5f3f (Track X fix, before 4787390d)  | 6    | 2     | epoch-3 seal, same IndexedDB pattern (one probed) |
| 4787390d (with the direct-send deadline) | 18   | 1     | epoch-3 seal, same IndexedDB pattern              |

Without the storm: base 12 fast runs (48 rollovers), no hang. 9b6b5f3f: 6 runs of 4 epochs, 6 of 16 epochs (one ended
at epoch 15 when the dev server and relays dropped under load 235, one could not start its web server), no hang; most
of these were slow (open after 30-77 s), so the open-time schedule was over before the first seal. The coordinator's
hang was a fast run: its epoch-3 seal came 6 s after the recipient joined.

The Track X fix adds history requests (after each install, and at most one a second while a vertex waits for a
dependency), and each one pushes the recipient's rows to the creator. That can add triggers, but the rates above do
not separate base from head. The fix for the deadlock belongs in the seal (section 9.4), not in the request path.

### 9.3 A direct send with no bound (fixed: 270c7068 RED, 4787390d fix)

Before the IndexedDB probe pointed at the seal, I suspected the creator's answer to a history request. It is a FIFO
task too: `republishRetained` awaited `networkNode.sendMessage(target, row)` with no signal, and the genuine send has
no bound without one (libp2p's stream close waits for idle or drain with no timeout). The node-level RED
(tests/track-x-stalled-direct-send-red.test.ts) shows that one stalled reply holds the creator's moves, seal and close.
The recipient's own history request send had the same shape, and while it hung every later request joined it, so the
recipient could never ask again. Both sends now carry a 10 s deadline (`RETAINED_DIRECT_SEND_DEADLINE_MS` in v3-live.ts,
`HISTORY_REQUEST_SEND_DEADLINE_MS` in room-network.ts); a reply send past it is aborted and ends that reply, and the
peer asks again while it still misses something. This is hardening: no observed hang had a send in flight. Each
deadline is one `AbortSignal.timeout` per send; nothing new is held.

### 9.4 Options for the seal deadlock

The coordinator chose option 1 (decision row 49); section 10 records the fix and where it differs from the text below.

1. Stage first: in `close()`, run `stageSnapshot` before taking the promotion or recovery source (3730, 3740-3746). The
   stage closes admission and drains the FIFO while no view is held; later ingress returns early because
   `blueprintClosing` is set. A source that then fails to acquire calls `abortSnapshotStage`, as a failed stage does
   now.
2. Release the source before `stageSnapshot` and reacquire it after, comparing identity, as `close()` already does
   around the archive work (3851-3916).
3. Narrower: skip the journal append for a vertex the creator already has. That removes the duplicate trigger only; a
   Writer's new move in the same window still deadlocks.

Option 1 or 2 needs a RED on the browser storage host (fake-indexeddb), with an ingress task held in the FIFO when
the seal takes its source. The native read reservation and the closed-rollback proofs carry G-guarantees, so I have not
changed them without a decision.

### 9.5 Notes

- **Private WeakMap count.** tests/phase-3a1-ac-live-persistence-red.test.ts already fails at base. Its count of
  top-level private WeakMaps in v3-live.ts goes from 18 to 19 with `v3MissingDependencyRequests` (24699ced). That map
  binds the room transport's request to a network node and the room's live topic, and it must outlive every successor
  plane of the session. The only existing per-node structure, `v3PlaneRegistrations`, holds plane registrations, and
  successor planes are activated with a closed input key set (`ACTIVATION_INPUT_KEYS`), so I kept the WeakMap. The
  direct-send deadline adds no WeakMap and no call the test forbids.
- **A flaky precondition in my own RED.** In d48b57cd's Writer case, a recipient's trailing missing-dependency request
  can bring the "lost" move back before the test checks that it is missing (seen twice under load 170-240, on head and
  base of 4787390d alike). The test does not assert anything wrong; the precondition races the repair it tests. I left
  it unchanged under the hard rules. Waiting a little over one request interval before losing the move would remove the
  race.
- **Harness.** 76ea48f2 and d46c3e74 add opt-in hang diagnostics (rollover timeout, step marker, network probe, all
  console lines, IndexedDB and Web Locks probe, bounded final closes) and the history-request storm. The storm is
  stress, not measurement.

## 10. The seal deadlock fix: stage before source (coordinator decision, Option 1)

### 10.1 RED (e1f471bb)

tests/track-x-seal-source-deadlock-red.test.ts, with the fixture tests/fixtures/track-x/seal-source-room.ts: a
settlement creator (creator-trusted-settlement-v1, the Grid zone application) alone on a browser storage host over
fake-indexeddb, with the genuine room session. The test watches `IDBDatabase.prototype.transaction` (observation only)
and, each time `close()` takes a journal source (a held journal view created under creator-close.ts `acquireSource`,
not under the promotion checkpoint taken before `close()`), delivers a copy of the creator's latest published vertex
back to the creator from the other peer, as a recipient's retained-history push does. Four cases:

| Host                                                       | Close                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| default six-database (no `storageHost`)                    | the epoch-2 seal (recovery source, creator-close.ts 3746)                                           |
| default six-database                                       | a promotion close (`promoteCreatorCheckpoint({closedEpoch: 0})` at epoch 1: promotion source, 3730) |
| room database (`createBrowserV3RoomDatabaseStorageHost()`) | the epoch-2 seal                                                                                    |
| room database                                              | a promotion close                                                                                   |

The room-database host deadlocks the same way: its live journal's held view covers the journal namespace of the room
database (`roomOwnerStoreNames`), and an ingress append writes that namespace.

At e26cd812 (node 22.15.0) all four cases hang past the 30 s bound; with `TRACK_X_RED_ECHO=0` (no copy delivered)
all four pass in 1-4 s, so the hang needs the ingress append and nothing else.

### 10.2 The fix (2a65f450)

In `close()` (packages/node/src/creator-close.ts), the `stageSnapshot` block and `lifecycle = "sealed"` move from
after the source block to right after the maintenance join, before the promotion source (3730) and the epoch-2
recovery source (3740-3746). Nothing else changes. The stage closes admission (`blueprintClosing`), waits for the
plane's admitted tasks while no journal view is held, so an admitted ingress append completes; ingress that arrives
later returns at `enqueueV3Ingress` (or at `authenticateV3Ingress` if it was queued earlier) without writing.

A source that fails after the stage now leaves the close `sealed` and retryable (the next `close()` skips the stage,
`stagedSnapshot` is kept, and takes the sources again). `abortSnapshotStage` cannot reopen a folded epoch: it returns
false once `blueprintFolded` is set (v3-live.ts 19774-19779), so calling it after a source failure would do nothing;
the close's existing catch already calls it only while nothing is staged. This is the state every failure after the
stage already left at base: the reconciliation's reacquire (3844), the archive and membership reacquires (3907-3916,
4074-4080), `persistSnapshot`. Before, a source failure left the epoch unfolded and the room `active`. For a promotion close
that was already partial: `acquirePromotionCheckpoint` had set `promotedEpoch` (4559), which keeps ordinary
issuance maintenance and readiness unavailable (3446, 4680). For an epoch-2 seal the room went back to ordinary play
in the same epoch.

This departs from decision row 49 ("aborting the stage if the source cannot be taken"): the fix does not call
`abortSnapshotStage` on a source failure, because after the fold that call returns false and changes nothing. If the
old outcome matters, the alternative keeps the order and splits the stage: close admission and drain the plane's
admitted tasks first, take the sources, then fold. A source failure could then be aborted (nothing folded yet). It
needs a new step in the close registration (v3-live.ts), and a proof that no task admitted while the sources are held
writes the journal (the closed gate stops ingress; local issue, publication and maintenance paths would each need
checking). So I did not make it without a decision.

### 10.3 What the old order protected, and why the new order keeps it

The source-before-stage order dates from the phase 6 checkpoint (ea4eb158); no comment, spec or test states a reason.
What it gave: a source failure did not fold the epoch (10.2). Nothing reads under the source's view during the stage:
`stageClosedBlueprintEpoch` folds the in-memory graph and `exportLiveSnapshotPayload` encodes in-memory state; neither
reads a store. The close already takes the recovery source after the stage when reconciliation released it (3838-3844),
and Track V's fence map (docs/realtime-latency/tracks/02-phase0-adoption-fence-map) counts up to three such
acquisitions per close.

- **Native read reservation (G11, G12).** The source takes the same held view, and holds it over the same later steps
  (graph capture, persistence, durable replay, cut, adoption facts) until the same releases. Foreign writers are still
  excluded natively for its whole life. The only change is that the view no longer spans the stage's wait for the
  plane, where exclusion was the bug: the plane's own admitted writer waited on it. No fact is carried across the view:
  the stage reads nothing durable, and every reuse of currency stays inside the view that read it.
- **Closed-rollback proofs (CRD, creator-closed-rollback-data.ts).** `acquireCreatorForwardPromotionSource` reads the
  same closed epoch (`epoch - 1`, or `promotedEpoch`) from the same stores and authenticates it afresh; the promotion
  identity check against the checkpoint (`promotionSourceIdentity`) and `checkCurrent` are unchanged. The stage writes
  none of the stores the proof reads. The proof's journal header is now taken after the plane's admitted tasks
  finished, so it sees the epoch's final journal instead of a journal that could not be written while it was held.
- **G3 (golden path).** The closed epoch is still exactly what the plane admitted before the stage task ran. The boundary
  moves earlier by the duration of the source acquisition: a move that arrives during it is no longer admitted into the
  closing epoch (in the browser it used to hang the seal; on the node host, by reading the code and not exercised here,
  its append meets the reservation's `BEGIN IMMEDIATE` and fails after the 1 s busy timeout, and a failed append of a
  new move halts admission). It reaches the successor through the retained-history requests and
  writer rebase, as any move arriving after the stage does. The durable close order (snapshot, durable replay, cut,
  head swap, adoption) is unchanged, so crash recovery sees the same states; the fold is in memory and a reopen
  rebuilds the plane unfolded from durable state.
- **G4 (no resurrection of terminal sessions).** No callback, timer or retry is added. A folded epoch cannot be
  reopened (`abortSnapshotStage` refuses), and late or replayed ingress meets the closed gate.
- **G14 (one bounded resumable retirement intent).** The retirement reconciliation (3799-3833) runs after the stage and
  the sources, unchanged. The stage's resume source is the registration's own `retirementResumeControl` or
  `retirementReconstruction`, not a close source. On a retry the stage is skipped and a pending reconciliation releases
  and reacquires the promotion source as before.
- **G17 (permanent fences, no late writers).** Admission closes earlier, so fewer late writes reach the closing epoch;
  the fences are written by the unchanged durable close and adoption.
- **G23 (lull ingress queues, nothing dropped).** A seal is not a lull. During a deferrable lull,
  `readinessMaintenanceEntered` still queues ingress at `enqueueV3Ingress`. At a seal, ingress after the stage was
  already dropped at base; the drop now starts at the stage instead of after the sources.
- **G22 (reservation before irreversible effects).** The fold is not a durable effect. Every durable effect still comes
  after the sources and their charges.

### 10.4 Proof

All runs on Node 22.15.0 and pnpm 10.24.0. "Merged head" is b8ad1f50: main 24d4ca61 (with Track Y) merged into
2a65f450. "Base" is the same tree with main's creator-close.ts put back (uncommitted, the file equal to
24d4ca61's). The machine's load average was 50-340 throughout.

| Check                                                                                                                                       | Base                                                                                                                                                                                        | Fix                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED, 4 cases (30 s bound)                                                                                                                   | e26cd812: 4 of 4 hang; main code at the merged head: 4 of 4 hang                                                                                                                            | 2a65f450: 4 of 4 pass, then 6 of 6 runs; merged head: 4 of 4 pass                                                                                                                   |
| RED control (`TRACK_X_RED_ECHO=0`)                                                                                                          | 4 of 4 pass in 1-4 s                                                                                                                                                                        | —                                                                                                                                                                                   |
| Storm harness (`TRACK_X_HISTORY_STORM_MS=250`, `TRACK_X_IDB_PROBE=1`, 4 epochs)                                                             | 2 of 30 hang (section 9.2)                                                                                                                                                                  | 2a65f450: 30 of 30 pass, 0 hangs; merged head: 31 of 31 counted runs pass, 0 hangs                                                                                                  |
| Canvas, real networking, 16 epochs                                                                                                          | —                                                                                                                                                                                           | 2a65f450: 16/16; merged head: 16/16                                                                                                                                                 |
| Chat, real networking, 16 epochs                                                                                                            | —                                                                                                                                                                                           | 2a65f450: 16/16; merged head: 16/16                                                                                                                                                 |
| Grid (Track V's harness) with Track V's four commits                                                                                        | —                                                                                                                                                                                           | merged head + d5a0015f, 15bf2ed1, 5b55b6e9, 27fe2688 (scratch branch track-x-grid-seal): 3 runs, 16/16 each; rows flat from epoch 7 (creator 169 rows / 13 issued, Writer 148 / 13) |
| Track M's seal-after-a-received-move race (no settle before the seal; Canvas and Chat, room and browser hosts, Writer, 4 epochs, 4 repeats) | 3 of 16 pass; 13 fail at the epoch-3 seal with "creator recovery role transfer source failed: internal-invariant" (the recovery source, creator-close.ts 3746), on both hosts and both apps | 16 of 16 pass                                                                                                                                                                       |

**The fix also removes Track M's seal race** (Track M RESULT, "A pre-existing race,
`NATIVE_READ_RESERVATION_BUSY`", the reason the settlement fixture and the Canvas and Chat runs wait 300 ms before
each seal). It is the other order of the same window. A scratch probe at main's code (observation only, the IndexedDB
`transaction` wrapper of the RED; <evidence>/track-x/trash/settle0-probe/, logs/settle0-probe-mpresl-2.log) shows
that when the recovery source fails, an admitted ingress task holds the live journal's view:
`authenticateV3Ingress` → `handleV3Ingress` → `acquireLocalReplacementCustody` (v3-live.ts 13969), then
`handleV3IngressWithSource` → `resumeJournalReads` (14064). The browser owner refuses a second view at once
(`NATIVE_READ_RESERVATION_BUSY`, native-read-reservation.ts 279), and `acquireClosedData` reports
`internal-invariant`. If the source is first, the task's append waits on the source instead: the deadlock of 10.1.
Staging first lets the task finish, with its view released, before any source is taken.

One storm run at the merged head (mstorm-1) is not counted: the page reloaded at 15:00:15 because
packages/node/tests/firewall.test.ts, in the node suite running alongside, runs `pnpm --filter @ts-drp/node build`
and rewrote packages/node/dist under the Vite server (the trace shows `src/index.ts?t=…`). The test failed with
"Execution context was destroyed".

**Latency bench** (healthy native Grid, 8 rollovers, default mode, 8 interleaved pairs in ABBA order, bundles built
at the merged head from main's creator-close.ts and from the fix; pooled medians of transitions 3 and later;
<evidence>/track-x/bench/runs/run-m\*, bin/bench_sum.py):

| Median (ms)       | Base   | Fix    |
| ----------------- | ------ | ------ |
| Seal              | 3392.2 | 3481.0 |
| Creator adoption  | 687.4  | 704.1  |
| Recipient install | 2065.1 | 2091.2 |
| Per-move issue    | 53.7   | 55.0   |
| Remote delivery   | 121.5  | 124.1  |

The fix is within 3% everywhere. Per pair, the seal is higher at the fix in 6 of 8 pairs (differences -174 to +450
ms), but so is the recipient install in 7 of 8, and the recipient does not run this code; with load averages of
160-350, these runs cannot resolve a difference of that size. The bench seals after its gameplay and a forced-GC checkpoint
(healthy-grid.ts), so the plane should hold no admitted task; the close then does the same work in a different
order. All 16 runs passed.

**Suites**, per test, base against fix at the merged head (<evidence>/track-x/tests/mpresl-_.json and mseal-_.json,
bin/vcompare.py):

| Set                                    | Base (pass / fail)      | Fix (pass / fail)       | Differences         |
| -------------------------------------- | ----------------------- | ----------------------- | ------------------- |
| packages/node                          | 1027 / 48               | 1027 / 48               | none                |
| storage-node retirement and room head  | 163 / 61 (2 pending)    | 163 / 61 (2 pending)    | none                |
| root room and native tests (246 files) | 828 / 350 (110 pending) | 828 / 350 (110 pending) | one each way, below |
| native Canvas and Chat                 | 35 / 15                 | 35 / 15                 | none                |
| startup-discovery observation          | 23 / 0                  | 23 / 0                  | none                |
| Grid and AOI                           | 65 / 0                  | 65 / 0                  | none                |

In the root set, the fix run failed d110c "puts ACL membership, genesis admission, adjacency, and monotonicity in the
bounded advance predicate" with `ReferenceError: Cannot access '__vite_ssr_import_8__' before initialization` (a
module-load race in the test worker); alone it passes (logs/rerun-mseal-d110c.log). The base run timed out phase-4c
"proves peak verifier ownership on 64 MiB", which passed at the fix. The failures common to both sides are the
existing ones of section 7 (the same counts as at 2a65f450 before the merge; the merge adds Track Y's four passing
node tests). `pnpm -r typecheck`: 0 errors, 46 of 47 projects. `node scripts/check-shadowed-sources.mjs`: clean.

## 11. The startup order (row 45): options, not implemented

The coordinator asked for options and no implementation. The startup RED of 9b6b5f3f stays red on this branch. The
prototype lives only on the scratch branch track-x-startup-seal (ef37befb, first written as 3e95ac40).

### 11.1 Where readiness waits

The settlement creator's startup barrier (`rebasePromise`, v3-room.ts:5705-5726) runs `waitForRetainedBootstrap`,
`publishAccepted`, `drainRebaseOutbox` and then `prepareCurrentCreatorOrdinaryReadiness`. Each publication is a plane
FIFO task: `publishPending` (v3-live.ts:16156) awaits `networkNode.publishMessage` (16248), and
`DRPNetworkNode.waitForPeersAndPublish` first waits for a subscriber (`waitForSubscriber`,
packages/network/src/node.ts:2929; at most 1000 ms in 25 ms polls, then it publishes to no one, which
`allowPublishToZeroTopicPeers` at 2334 permits). The drain's `issueSettlement` publishes after each issue as well.
`room.issue` awaits the same barrier (v3-room.ts:7278) after it presents the move locally.

The order is pinned. `packages/node/tests/creator-ordinary-readiness-producer.test.ts:1578-1627` ("room explicit
readiness boundary wiring") takes the source text of `prepareCurrentCreatorOrdinaryReadiness` and `rebasePromise`,
runs it with stubs, and requires `["enqueue", "bootstrap", "publish", "drain", "prepare"]` on v1. Its title is "joins
preparation after startup publication/rebase and before the existing barrier resolves". Any new identifier in the
barrier text also breaks it, because the stubs define only the names it uses today.

### 11.2 The prototype

On v1 only: the drain issues its fence and replacements without publishing them; readiness is prepared on the local
postimage; then `publishAccepted` publishes every accepted row in author-sequence order, and only then does the
barrier resolve. The creator's own gossip republication of retained history (no target peer) is held until the
barrier settles, at most one held; direct replies are not held. Successor adoption drains still publish each issue at
once.

| Check                                                                       | Result                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Startup RED (9b6b5f3f)                                                      | passes (logs/startup-red-proto1-r1.log)                        |
| Wiring test (pinned order)                                                  | fails: v1 order becomes enqueue, bootstrap, drain, prepare (1) |
| d9346, seal fix, no prototype (md9-base-1)                                  | line 474 fails, migration passes                               |
| d9346, prototype and seal fix (md9-proto-busy-1..3, md9-proto-seal-mp-1..6) | 9 of 9 runs pass both tests                                    |
| d9346, prototype on main's `creator-close.ts` (presl, mq, mp runs)          | 10 of 12 pass; 1 BUSY; 1 transfer failure (2)                  |
| d9346, prototype at 9b6b5f3f (d9346-startup-r1, older base)                 | both tests fail with BUSY                                      |

(1) The other six failures in that run (logs/wiring-proto1.log) are five timeouts under load and one that fails at
base too. (2) md9-proto-presl-mp-2 failed at the rollover with "snapshot peer has no open unlimited authenticated
connection" (connection-unavailable), with no BUSY; I have not seen it elsewhere.

### 11.3 The NATIVE_READ_RESERVATION_BUSY

A probe in the built storage-browser dist (bin/patch-busy-probe.py, never in src) logged both stacks
(data/md9-proto-presl-3-trace). Two refusals came on the creator's `--ahe` database at 4217 and 4300 ms page time:

- **Holder**: `acquireCreatorIssuanceMaintenanceProof` (creator-closed-rollback-data.ts:6682), holding the view
  since 3606 ms, before the Writer had even connected (about 3960 ms). The zone was at epoch 0 with one durable vertex
  before and after, so no close was running. Local issues, the drain's fence among them, run their maintenance job
  inside a plane FIFO task (`enqueueLocalIssue`, v3-live.ts:15149-15158), so they cannot overlap ingress. The one
  holder outside the FIFO at that point is the readiness job: `prepareOrdinaryReadiness` (creator-close.ts:4677, an
  owner maintenance job started from the room barrier) → `captureCreatorOrdinarySourceWithoutForecast` (2460) → the
  proof (2473). A second probe that names the caller (bin/patch-maintenance-probe.py) never fired, because 14 further
  runs had no BUSY. The holder is therefore identified by elimination, not by a stack.
- **Refused**: the Writer's first append. A creator bound for maintenance takes local replacement custody before it
  consults the maintenance consumer (`handleV3Ingress`, v3-live.ts:7556-7569). The browser reservation refuses at once
  (storage-browser native-read-reservation.ts:279); the node reservation waits under `busy_timeout`. The catch logs
  `admission-rejected received-maintenance-custody` and returns false **without retaining the append**. When the
  consumer itself refuses for the same reason (a maintenance job in flight, creator-close.ts:3438-3450), the append is
  kept as pending ingress (v3-live.ts:7730-7737), as the pending-ingress drain says it must ("Retain exact unadmitted
  work until durable delivery succeeds", 7471). The creator then logged `graph-rejected`, left the room topics, and
  `zone()` threw "creator held issuance census is unavailable".

So the BUSY is not caused by the reorder. It is an existing asymmetry, and the reorder lines the readiness job up with
the first joiner's append. The same path exists without the prototype: startup and successor-install readiness
(v3-room.ts:5716, 6667) both run outside the FIFO. I have not seen it without the prototype. The seal fix only changes
`close()`; 9 of 9 against 10 of 12 does not show that it matters here.

### 11.4 Options

Each of A, B and C prepares readiness before the first join, so each also needs one of these BUSY fixes:

- **(i) Retain on a custody refusal.** In `handleV3Ingress`, keep the append as pending ingress when custody cannot
  be taken, as the consumer-refusal path already does. That is bounded by `maxPendingEntries` and `maxPendingBytes`
  and counted in the census (G21). Pending ingress is retried today only after the next successful ingress (7974), so
  the end of the maintenance job should also trigger the retry. That trigger is event-driven, not a timer. This also
  covers installs. It is the smallest change.
- **(ii) Serialize readiness with ingress.** Run the readiness job as a plane FIFO task. Ingress then waits behind
  the cold capture (hundreds of ms on this machine), and the job would move into the plane, which is a bigger change.

The orders:

- **A. Reorder on v1 (the prototype).** Readiness is prepared before publication, and the barrier still resolves only
  after every accepted row is published, so "started up" still implies "published". The publications still wait for
  a subscriber. Evidence: the RED passes, and d9346 passes 9 of 9 with the seal fix. Cost: the owner must amend the
  pinned wiring test to the v1 order `enqueue, bootstrap, drain, prepare, publish` (I did not edit it). One cost
  remains: a placement made while the creator is still alone still waits for the barrier's last publications (at
  most 1 s per pending row), but it builds nothing.
- **B. Keep the barrier text, stop the barrier from waiting on publication.** On v1 at startup, `publishAccepted` and
  the drain's publication would hand the pending rows to one bounded background publisher, which waits for a
  subscriber outside the plane FIFO and then publishes in order. The pinned test passes by its letter, but its title
  ("after startup publication") stops being true, and "started up" no longer implies "published". This needs a no-wait
  subscriber check on the plane's network port (`getGroupPeers`, node.ts:2793), a "deferred" egress result, and the
  publisher's bound. G19 holds the issuance retention owner while rows stay pending. Not prototyped.
- **C. Do not wait when the topic has no subscriber at all.** In `waitForSubscriber`, return at once when
  `getSubscribers(topic)` is empty. This is the smallest diff, but it changes every app and both profiles. A joiner
  whose subscription is still in flight loses the gossip copy and must repair it. The startup RED's second assertion
  (the startup publications reach the Writer by gossip) would fail, and existing REDs are not edited to pass. Not
  prototyped.

Without a fix, row 45's placement stays cold: section 6.1, options 1 and 3, which row 45 rules out.

My preference, for the owner to decide: A with (i). A keeps the publication semantics and the delivery wait, and
touches only the room's barrier and the drain's publication mode. (i) closes a drop that can happen without A.

## 12. Decision row 51: A, and the readiness ingress hold

The owner chose startup option A, together with a fix for the NATIVE_READ_RESERVATION_BUSY. The first choice of BUSY
fix was (i), retain on a custody refusal. The owner then replaced it with (a): run the readiness capture in a plane
FIFO slot, and keep (i) only together with (a). Written literally, (a) leaves a hole (12.2), so the coordinator
approved the readiness ingress hold as the way row 51 is implemented. The owner then chose to ship the hold without
(i), because (i) breaks the creator's own moves (12.5). An append refused custody by a holder outside the FIFO is
dropped, as at base.

Log, script and patch paths in this section are under <evidence>/track-x/ unless they name a repository file.

### 12.1 A (f86f8a0a) and the wiring amendment (7256d607)

These match the prototype of 11.2, with its comments renamed to row 51. On v1 the startup barrier now runs:

- enqueue and bootstrap;
- drain, with the publication deferred (`settlementDrainPublication: "after-readiness"`);
- prepare readiness;
- `publishAccepted`, before the barrier resolves.
  The owner-approved amendment to `creator-ordinary-readiness-producer.test.ts` makes three changes:
- line 1609 expects `enqueue, bootstrap, drain, prepare` while the barrier is held;
- after `room.done` the test requires `enqueue, bootstrap, drain, prepare, publish`;
- the title says preparation is joined "after the startup rebase, before startup publication".
  The startup RED of 9b6b5f3f passes.

### 12.2 Why (a) as written leaves a hole

A slot like `runCreatorOrdinaryReadinessMaintenance`'s would cover the capture only. The readiness job is longer:

- On the window and recovery path it captures (a warm refresh or a cold capture).
- Then, when the capture is not certified, it runs `runOrdinaryReadinessMaintenance`, its own FIFO slot.
- Then it captures cold again (creator-close.ts, `prepareOrdinaryReadiness`).

An append that arrives during the first capture queues behind that capture's slot. It then runs before the
maintenance slot, while `maintenanceJobs` is not empty, so the consumer refuses it and keeps it as pending ingress
(v3-live.ts `retainPendingIngress`). The readiness boundary is not deferrable. Its runtime census requires no pending
ingress (`captureCreatorRecoveryRuntime`, `live()`: `pendingIngress.size === 0` when the observation is not active),
so the boundary fails and the startup or install barrier makes the creator terminal. Closing this inside (a) would
need the slot to span the whole job, or the pinned `prepareOrdinaryReadiness` text to change. The hold spans the whole
job and changes no pinned text.

### 12.3 The hold (04135190)

- `prepareCreatorOrdinaryReadiness` (creator-close.ts) takes the hold from its plane before the job and releases it
  in a `finally`. That covers success, failure, a terminal failure and a synchronous throw.
- `holdV3IngressForReadiness` (v3-live.ts) sets `registration.readinessIngressHold` to an unresolved promise. It then
  flushes the FIFO with an empty task, so every task queued before the hold finishes before the job starts. If the
  flush throws, the hold is released and the error is rethrown. A second hold on the same plane is refused. Release
  is idempotent.
- `enqueueV3Ingress` reads the hold and passes it as its input-admission barrier, alone or joined with a terminal
  barrier. The arrival is first captured and charged to the bounded input pool (`captureBeforeBarrier`: 32 jobs,
  `maxPendingBytes`), with no FIFO reservation and no pending-ingress entry. When the hold is released, it enters the
  FIFO in arrival order and runs the full admission path.
- While a hold is set, the closing-gate drop at enqueue is skipped, so the arrival queues instead.
  `authenticateV3Ingress` still drops it if the gate is still closed when it runs, which is the case after a failed
  readiness boundary or a close.

Every function touched:

- v3-live.ts: the `V3PlaneRegistration.readinessIngressHold` field, `enqueueV3Ingress`, the new
  `holdV3IngressForReadiness`, and the `holdIngressForReadiness` property of `creatorCloseRegistration`.
- creator-close.ts: `V3CreatorCloseRegistration.holdIngressForReadiness`, the `runtimeReleaseOwners` value type, the
  owner's `holdIngressForReadiness` in `bindCreatorLiveClose`, and `prepareCreatorOrdinaryReadiness`.
- v3-room.ts: no edit beyond A.

G1-G28:

- Nothing is admitted without the full path: a held arrival runs `authenticateV3Ingress` and every admission check
  after release.
- What is held is bounded and counted by the same input pool, joined work and gossip pool as today (G21, G22).
- Nothing is re-requested on a schedule.
- No recipient is deaf: the hold is released on every path, and held arrivals then proceed.

### 12.4 Why the hold cannot deadlock

- Only `enqueueV3Ingress` reads the hold. It waits on it through `inputAdmission.barrier`, and
  `enqueueRegistrationTask` takes the FIFO reservation only after the barrier resolves (`barrier.then(enqueue)`). So
  a held arrival holds no FIFO slot and no native reservation; its capture copies wire bytes only.
- Promises that wait on held arrivals are awaited in three places, none of them a FIFO task:
  - the gossip queue subscription in `activateV3LivePlane`, whose message-queue fanout awaits the handler;
  - `routeV3RetainedIngress`, which uses `void`;
  - `deactivateV3LivePlaneJoined` through `joinedWork`. The room calls that from `shutdown` only after
    `creatorCloseHandle.stop()`, which waits for the readiness job.
- The readiness job awaits:
  - the flush;
  - its native captures;
  - `prepareOrdinaryNativeMetadataForReadiness`;
  - its own maintenance FIFO slot, which runs behind FIFO tasks only, and those never wait on held arrivals.
    None of these waits on the hold, and the hold is released when the job settles.
- The unit test pins this. It checks that only `enqueueV3Ingress` reads `readinessIngressHold`, and that it passes
  the hold as its barrier with `captureBeforeBarrier: true`. It checks that only the readiness preparation takes the
  hold, and where `enqueueV3Ingress` and `joinedWork` are used. It also runs a FIFO task queued after held arrivals,
  and that task completes while they wait.

### 12.5 (i): retaining an append whose custody was refused

I wrote (i): `handleV3Ingress` keeps the append as pending ingress when `acquireLocalReplacementCustody` throws. Its
node-host test (<evidence>/track-x/data/track-x-custody-refusal-retain-red.test.ts, uncommitted) stands in for the
holder at v3-room.ts 5383: the test itself holds the creator's floor reservation while the Writer's move arrives,
releases it, and the creator then plays.

- At f86f8a0a the move is refused custody and lost (logs/retain-red-base-r2.log).
- With (i), the creator's own next move is refused: `issuance-rejected ... creator recovery dependency hold
unavailable:replay` (logs/xreds-head-r1.log).

The reason is the census. `readCreatorRecoveryDependencyCensus` refuses any pending-ingress entry whose parents are
all present, unless it is the received append being admitted (v3-live.ts, `missingParents.length === 0 &&
active.enteredReceivedDigest === undefined`). A local issue on a maintenance-bound creator reaches that census
through `prepareCreatorIssuanceMaintenanceQuote` (creator-close.ts:2154; probe logs/retain-probe-r2.log). So a kept,
ready append blocks the creator's moves until another append is admitted or a maintenance job ends.

For the real 5383 holder it is worse. The split replacement holds its floor view outside the FIFO, then calls
`source.withDependencies`, a FIFO read-control task that seals an active census, while it still holds that view. An
append queued ahead of that task is refused custody. If it is kept, the census refuses and the replacement fails; at
base it is dropped and the replacement goes on.

A drain before each local issue (a probe in `issueLocal`) makes the stand-in pass (logs/retain-alpha-r1.log). It
cannot help 5383, though, because the floor view is still held while that census runs. I reported this to the
coordinator with three options:

1. Ship the hold without (i).
2. (i) plus a drain before each issue.
3. Have the 5383 replacement take the ingress hold around its floor view.

The owner chose option 1. (i) is in no commit. It is kept in <evidence>/track-x/data/hold-fix-v1.patch, which holds
both the hold and (i), and its test in <evidence>/track-x/data/track-x-custody-refusal-retain-red.test.ts. The 5383
loss stays open (12.9).

### 12.6 Tests

The RED (83176da6, committed before the fix) uses a new node-host fixture, tests/fixtures/track-x/readiness-hold-room.ts.
It runs a creator and a Writer on the SQLite host, with hooks on the creator's floor reservations, so a test can
deliver a Writer move at an exact point inside the creator's readiness job.

| Test                                                                  | What it requires                                                                                                                                                                              | f86f8a0a (A only)                                                               | Head  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| track-x-readiness-hold-red: startup                                   | A Writer move that reaches the creator during its startup readiness is admitted after the job; the creator stays live and plays.                                                              | fail: the move is refused custody and lost                                      | pass  |
| track-x-readiness-hold-red: maintenance                               | The hole of 12.2: an append arrives during the capture of a readiness job whose source then needs maintenance (epoch-3 adoption, uncertified window). Admitted after; the creator stays live. | fail: adoption terminal, "creator ordinary runtime custody is stale or revoked" | pass  |
| track-x-readiness-hold-close: close while held                        | close() while the hold is set. Close waits for the job; the held move then meets the closed plane; nothing hangs; nothing is admitted after the stage; native owners join.                    | -                                                                               | pass  |
| track-x-readiness-hold-close: seal while held                         | A seal staged while the hold is set. Nothing is admitted after the stage; the held move is not in the cut and is replaced into epoch 2; both projections are equal.                           | -                                                                               | pass  |
| packages/node/tests/track-x-readiness-ingress-hold.test.ts (15 tests) | Runs the real source of the hold, `enqueueV3Ingress`, `enqueueRegistrationTask`, `authenticateV3Ingress` and `prepareCreatorOrdinaryReadiness` against a small plane.                         | -                                                                               | 15/15 |

The unit file covers the coordinator's list:

- Held arrivals take no FIFO reservation. A FIFO task queued after them runs while they wait, and they are admitted in
  arrival order after release. The flush runs every task queued before the hold first. A terminal barrier and the
  hold are both waited for.
- The closing gate. With no hold, a seal's or a close's closing gate still drops at enqueue, and only an entered
  readiness boundary queues. Under a hold, an arrival during a closing gate queues and then meets the gate in
  `authenticateV3Ingress`. Arrivals held on a plane that was deactivated meanwhile are dropped.
- The pool. With the hold set, the 33rd arrival (32 jobs) and the arrival past `maxPendingBytes` get the existing
  input-pool refusal (`admission-rejected`). The logs, counters and decodes are identical to the same arrivals behind
  a busy FIFO task, so there is no new drop path. A refused arrival is handled as today: the next move that depends
  on it is retained as pending ingress and asks for it again (24699ced).
- Release on every path: a second hold is refused without disturbing the first; a throwing flush releases the hold
  and every arrival behind it; `prepareCreatorOrdinaryReadiness` releases after success, failure, a terminal failure
  (`AggregateError`) and a synchronous throw; when the hold cannot be taken, the job never runs.
- No FIFO task can await the hold (12.4): the static checks, and the runtime check that a FIFO task queued after held
  arrivals completes.

The coordinator also asked for (i)'s retain under the hold, tested with the test holding the creator floor's native
reservation as a stand-in for v3-room.ts 5383. That test exists (tests/track-x-custody-refusal-retain-red.test.ts,
uncommitted, kept in <evidence>/track-x/data). (i) is not in this branch, for the reason in 12.5.

The hold flushes the FIFO with one empty task of its own, so it must never run inside a FIFO task. Its two callers,
`prepareCurrentCreatorOrdinaryReadiness` at startup (inside `enqueueLifetimeTransition`) and after an install
(`performCreatorSuccessorAdoption`), run in lifetime transitions, not in plane FIFO tasks. The
readiness job's own FIFO work is its existing maintenance slot. Every hold in the runs of 12.7 completed its flush.

### 12.7 Cost to real-time play

Three builds were measured:

- base: b8ad1f50 node source, before A;
- A only: f86f8a0a;
- head: A and the hold, with a probe that reports each hold (data/hold-probe.patch, not committed).

Each bench mode ran 4 rounds of base, A only and head, interleaved, at 8 rollovers. Every run passed. The figures pool
those runs.

Every shipped harness stops play during a rollover: this bench, the Track X Canvas and Chat harness, Track V's Grid
harness, d9346 and Track M's long-room driver. The creator seals, exports and adopts, and the Writer installs, with no
moves in between. So every latency figure to date, these included, assumes that pause. With play through the rollover,
a Writer can be lost (12.10). The proof of that fix must include runs with continuous play through rollovers.

**Hold windows, in Chromium (head with the probe).** The window runs from the hold to its release.

| Mode                       | Create              | Reopen              | After installs (n=32)      | Moves that arrived during a hold |
| -------------------------- | ------------------- | ------------------- | -------------------------- | -------------------------------- |
| default                    | p50 90, max 118 ms  | p50 296, max 400 ms | p50 64, p90 82, max 105 ms | 0 in 40 holds                    |
| room database and `LULL=1` | p50 102, max 105 ms | p50 876, max 912 ms | p50 66, p90 77, max 96 ms  | 0 in 40 holds                    |

No move arrived during a hold, so in the bench the wait behind the hold was zero at every percentile. The bench plays
its moves after each transition.

**Move delivery and the creator's first move, base / A only / head.** These are pooled medians over transitions 3 and
later. "Installs" pools the moves after all 8 installs (n=32 per side).

| Mode          | Adoption ms     | Delivery ms          | Creator's 1st move after installs (p50) | 1st recipient move to creator (p50) | Creator's 1st move after create (p50) |
| ------------- | --------------- | -------------------- | --------------------------------------- | ----------------------------------- | ------------------------------------- |
| default       | 531 / 551 / 543 | 99.5 / 102.2 / 100.7 | 92.1 / 90.2 / 93.6                      | 102.8 / 93.0 / 94.9                 | 81.2 / 99.0 / 97.1                    |
| room database | 590 / 563 / 576 | 93.8 / 90.8 / 93.5   | 115.5 / 112.7 / 116.3                   | 92.0 / 87.6 / 89.8                  | 81.9 / 126.5 / 113.5                  |

After installs, all three builds are within the run-to-run spread. Between rounds, the same build's delivery median
moves by up to about 30 ms (default: base 87 to 115, head 91 to 125). The one cost is A's at create, described in 12.9.

**The worst case, on the node host.** This used a scratch test, <evidence>/track-x/data/track-x-scratch-hold-wait.test.ts.
At each of 8 installs, the Writer's move reaches the creator the moment the creator's readiness capture takes its first
floor reservation. The test ran 2 paired rounds per build.

- Head: the move waits behind the hold for p50 54, p90 61, max 66 ms (n=16). It is admitted p50 131, p90 146, max 149
  ms after it arrives. One move at a time, outside readiness, the Writer's moves are admitted in p50 40 ms.
- A only: the creator is terminal at epoch 1 in both rounds ("creator ordinary runtime custody is stale or revoked").
  That is the hole of 12.2.

So the hold delays only a move that lands inside its window of about 60 ms. At base, that same move is lost, or the
creator is lost.

**Streaming, on the node host.** In <evidence>/track-x/data/track-x-scratch-hold-stream.test.ts, the Writer plays one
move after another:

- Started when the creator's capture starts, every move arrives after the hold, because the Writer's issue takes 40 to
  70 ms. The wait is p50 79.5, max 94 ms, and 8/8 epochs complete.
- Started after the adoption, the first move per epoch waits p50 129 ms at head against 134 with A only. Later moves
  wait 156 against 163.

**Shipped pages, real networking, paired against main's node source.** These ran on the Grid scratch branch of 12.8
(head plus Track V's 4 commits), with the node dist rebuilt for each side, alternating base and head (logs/ccpair-hc.log,
gridpair-hg.log, grid-pair-sum.txt).

| Page and harness                   | Runs             | Creator's 1st move issue p50 (ms) | 1st move delivery p50 | Adoption p50         | Install p50             |
| ---------------------------------- | ---------------- | --------------------------------- | --------------------- | -------------------- | ----------------------- |
| Canvas, Track X harness, 16 epochs | 2 + 2, all 16/16 | 415 / 402.5                       | 112.5 / 110.5         | 1192 / 912           | 1996 / 1735             |
| Chat, Track X harness, 16 epochs   | 2 + 2, all 16/16 | 408.5 / 405.5                     | 7.5 / 9.0             | 978 / 1177           | 1872 / 1789             |
| Grid, Track V long room, 16 epochs | 2 + 2, all 16/16 | 265, 210 / 190, 479               | -                     | 857, 954 / 641, 1020 | 2407, 1997 / 1997, 2393 |

Figures are base / head. For Grid they are per run (epochs 2 and later): the second head run was slow in every phase
(seal 5 to 8 s against 3 to 4 s in the other three runs, load 60 to 114), so the runs are shown apart. The first head
run is the fastest of the four. The hold does not gate the creator's own issue, only remote ingress. These harnesses
play only after each transition completes, and these runs carried no hold probe, so they bound the cost to play
between rollovers, not the wait behind a hold.

### 12.8 Proof

The branch was merged with main at ebf4254f before these runs (4f5fc446, clean). Its node source then differs from
main's by A and the hold only.

**REDs.** At head:

- the startup RED of 9b6b5f3f passes;
- the hold REDs and the close/seal tests of 83176da6 pass;
- the amended wiring test passes;
- the seal RED passes;
- the 15 unit tests of the hold pass.

**Suites, per test, head (4f5fc446) against main's node source.** Both sides ran in the same worktree, with only
packages/node/src swapped.

| Set                                                        | Main's node source | Head               | New failures            | Fixed                                                 |
| ---------------------------------------------------------- | ------------------ | ------------------ | ----------------------- | ----------------------------------------------------- |
| packages/node                                              | 1027 pass, 63 fail | 1042 pass, 48 fail | 0                       | 15: the hold's unit tests and the amended wiring test |
| storage-node retention and native set                      | 163 / 61           | 163 / 61           | 0                       | 0                                                     |
| Canvas/Chat native set (6 files)                           | 35 / 15            | 35 / 15            | 0                       | 0                                                     |
| startup-discovery observers                                | 23 / 0             | 23 / 0             | 0                       | 0                                                     |
| Grid (examples/grid/src and the e4-01, e4-03 REDs)         | 65 / 0             | 65 / 0             | 0                       | 0                                                     |
| Chat window (chat-local-archive, chat-rolling-window-rule) | 21 / 0             | 21 / 0             | 0                       | 0                                                     |
| storage, storage-browser, storage-node                     | 1000 / 304         | 1000 / 304         | 0                       | 0                                                     |
| root room and native tests, Tracks K to X (277 files)      | 1393 / 361         | 1399 / 355         | 1, a load flake (below) | 7                                                     |

- The one new root failure is d110c "puts ACL membership ...", a vite SSR ReferenceError from module load order. Run
  alone at head, it passes (logs/d110c-mh-r1.log). The only d110c failure left alone is "centralizes the settlement
  profile predicate", which also fails at main.
- The 7 fixed root tests are the Track X startup and hold REDs and their close/seal tests, which test new code, and
  grid-memory-terminal-readiness plus two phase-6b-grid-successor-state tests, which fail at main's node source and
  pass with A and the hold.

**Track V's 4 commits** (d5a0015f, 15bf2ed1, 5b55b6e9, 27fe2688) cherry-pick cleanly onto 4f5fc446 (scratch branch
track-x-hold-grid: 5f03a254, bc1ba50e, 372a03f9, 65898f68). The shipped-page runs below are on that branch.

**Shipped Grid, d9346 (both tests), with Track V's switch.** 36 runs. The node dist was rebuilt for each side. Runs
marked "probe" carry data/admission-probe.patch, which only labels each unlabelled admission refusal. Indexes:
logs/gridpair-hg.log, d9pair-hd.log, d9pair-hm.log, d9pair-hn.log, d9probe-hp.log and d9probe-hq.log.

| Build              | Runs | Placement test fails                                       | Migration test fails at 915 |
| ------------------ | ---- | ---------------------------------------------------------- | --------------------------- |
| Main's node source | 8    | 4, all at 534 (Track V's known "future resource programs") | 1                           |
| A only (f86f8a0a)  | 4    | 1, at 419: the creator is terminal at startup (below)      | 2                           |
| Head               | 14   | 2, at 534                                                  | 8                           |
| Head, probe        | 10   | 0                                                          | 0                           |

- The migration test fails the same way at every build. After the migration, the rejoined joiner's "target-suffix"
  block never reaches the creator. The creator logs bursts of `admission-rejected` about 5 s apart. With the probe, the
  only labels in the passing runs are `refuse-pool`, the input pool's existing 32-job refusal, in bursts of 9 to 40 when
  a retained republication lands, and the retained-bootstrap gossip drop. My reading, not yet proven: the block arrives
  while the creator's pool is full, is refused, and nothing asks for it again because nothing depends on it.
- It depends on load. At load 75 to 196, head failed it 6 times in 10 and A only 2 in 4. At load 17 to 55, head failed
  it 2 times in 14. Main's node source ran at load 27 to 71 and failed it 1 time in 8; it did not run at high load.
- The placement failure at 419 with A only is the hole of 12.2 on a shipped page. The creator logs
  `received-maintenance-custody` refusals at startup, then every snapshot throws "Refusal". It did not happen at head
  in 24 runs.

**Typecheck and guard.** With the node dist rebuilt (`tsc -b tsconfig.build.json --force`, then build) at 4f5fc446:
`pnpm -r typecheck` has 0 errors, and `node scripts/check-shadowed-sources.mjs` passes.

### 12.9 Open items

- **The 5383 loss.** An append that meets a custody refusal while the split replacement at v3-room.ts 5383 holds the
  creator floor's view (outside the FIFO) is dropped, as at base. It comes back only if a later move depends on it and
  the recipient asks for it again (24699ced).
  - Why (i) did not fix it: `readCreatorRecoveryDependencyCensus` refuses a pending entry whose parents are all
    present unless it is the received append being admitted. So a retained, ready append makes the creator's next
    local issue fail ("creator recovery dependency hold unavailable:replay"). At 5383 itself, the census runs while
    the floor view is still held, so the replacement would fail too.
  - Candidate fix (option 3): the split replacement takes the readiness ingress hold around its floor view. Arrivals
    would then wait outside the FIFO, as they do during readiness, so none meets the refusal.
- **Retained reads can BUSY the readiness capture.** This predates row 51. The hold stops ingress only. A
  retained-history read is a FIFO task with a native read reservation, so it can overlap the capture, which then meets
  `NATIVE_READ_RESERVATION_BUSY`. The fix is a capture slot plus one stub line in the pinned
  creator-ordinary-readiness-producer.test.ts, which is the owner's call (coordinator, row 51).
- **Play during a rollover can lose a peer (12.10).** This predates row 51, and it is the next step of this track.
- **d9346's migration test loses a block with Track V's switch (12.8).** It fails at main's node source too, more
  often under load. In the labelled runs, a retained republication overflows the receiver's 32-job input pool, with
  9 to 40 refusals at a time. A block refused there comes back only if a later move depends on it. Not root-caused;
  it should be settled before Track V's switch merges.
- **A's cost at startup.** The creator's first move after create is about 16 ms slower in default mode (98 to 100 ms
  against 82, n=4) and about 35 to 45 ms slower with the room database (115 to 128 against 82), because publication
  now waits for readiness. Moves after installs are unchanged (12.7).
- **A pre-existing failure.** creator-ordinary-readiness-producer.test.ts, "readiness-owned recovery source
  acquisition > uses the genuine same-head pair ...", fails at f86f8a0a and at head alike (logs/pinned-base-r1.log).
- **An unlabelled function in the bench bundle.** tests/fixtures/startup-discovery/build.ts maps function names to
  phase labels, and the new `holdV3IngressForReadiness` has no label there. The bundle builds and runs. That file is
  Track U's, so it is left alone.

### 12.10 Play during a rollover can lose a Writer

This predates row 51. It fails the same way at main's node source and at head, and it is the next step of this track
(section 13). The rows below were found with a node-host scratch test, track-x-scratch-drain-race.test.ts (kept
in <evidence>/track-x/data, not committed), and a scratch copy of Track V's Grid harness.

**The repro.** On creator-trusted-settlement-v1, with a creator and one Writer:

1. The Writer makes one move while the creator seals epoch N (or while it adopts epoch N+1). The move is outside the
   sealed cut.
2. The creator seals, exports and adopts.
3. The Writer installs epoch N+1. Its settlement plan has one entry for that move, disposition "rebase". Its install
   drain (`performCreatorSuccessorAdoption`, received, then `drainRebaseOutbox`, then `drainSettlementOutbox`) issues
   the replacement, which fails: "authorization-rejected: active replacement source custody refused: portable source
   protected dependency is unavailable".
4. The install throws, the received-adoption catch sets the terminal failure, and the Writer is terminal. It no longer
   receives or plays.

A single move 50 ms into the seal is enough (logs/race-wds-cap1-main-r1.log at main's node source,
race-wds-cap1-head-r1.log at head). Continuous play through the rollover fails at epoch 1 in 3/3 (race-wdr-_), and so
does play only during the adopt (race-wda-head-r1). The creator playing while the Writer installs is fine (6/6,
race-cdi-_).

**Shipped pages.**

- Grid can reach it. In the scratch Grid harness the Writer places a block every 100 ms through the creator's seal,
  export and adopt. The Writer's install fails at epoch 1 with the message above, at head in 2/2 runs and at main's
  node source in 1/1 (logs/hg-race-head-1, -2 and hg-race-mseal-1, on the Grid scratch branch).
- Canvas and Chat cannot reach it as shipped: their joiners only observe and never issue, so a joiner has no move to
  rebase.
- Every shipped harness pauses moves through rollovers (12.7), which is why none of them has shown it.

**A second order, fixture only.** If the Writer installs and plays before the creator adopts, the Writer's row is
pending at the creator with a dependency the creator does not have yet. The creator's settlement fence then fails
("prospective runtime census has unresolved ingress or rebase dependencies"), and the creator is terminal at epoch 1.
No shipped harness installs before the creator adopts.

**First read on the cause (to be checked in section 13).** `preparePortableSettlementSource` walks the replaced move's
dependencies back to the source anchor. Each vertex on the way must be the anchor or a carrier in the census bytes. The
move's parents are rows that were settled into the cut, so they are neither, and the walk throws. Either the walk
should stop at vertices the successor already holds as settled, or the census should carry them. For the second order,
the census rule (`prospectiveCreatorRuntimeCensusOverhead` requires empty pending ingress for a local issue) and the
drain order (the fence is issued before pending Writer rows are resolved) are the two places a fix could go.

## 13. Play during a rollover (row 60)

Row 60 asked for 12.10 first. The work found one defect after another, each owned by the owner's rows 62-68, and
the coordinator then stopped the per-case rules in favour of one contract (row 71, 13.4). Every fix below has its
own RED commit first, and each failed at the commit before its fix.

### 13.1 What was found and fixed

| Item | What failed | Fix (RED) |
| ---- | ----------- | --------- |
| R1 | A Writer's move made during the creator's seal or adoption: the next install's replacement prepared the portable source (`preparePortableSettlementSource`) although a non-creator Writer's replacement is nonportable and the result was thrown away; the walk needs other authors' rows the Writer's census never holds. | bb357ac1 (2863424c, 0a3cce4f) |
| R2 | The second replacement in one install drain refused in the census: the already-replaced source looked open. | bb357ac1 (same RED, continuous case) |
| R4 | The next install's received turnover census refused a source replaced nonportably in the epoch before (completion was recognised only through a signed settlement source). | e47f6b8b (fc4bd2af) |
| R5 | A Writer's journal scope holding its own move made outside the cut was never collectible; protected scopes grew one per epoch and the 9th install failed ("journal retirement refused: malformed-input"). Row 62. | daf61067 (357ddea2) |
| R5b | The same for a received row outside the cut (another Writer's move during the seal). Row 64 (B2). | 986e1d05 (13793d94) |
| R7 | A Writer's own fence outside the next cut kept its scope for good (Track J's counterexample). Row 67. | b8268291 (128b066e) |
| R6 | When a Writer's whole install output missed the next cut, the following install failed the census on every retry: the derivation needs the source epoch's ACL. Row 66 (R6-A). | 4cbef3d7 (128b066e) |
| C1 | A replacement that itself missed the next cut wedged every later plan write. Row 65. | 6f37faae (77ffef9a) |

The play-through RED (tests/track-x-play-through-rollover-red.test.ts) passes its cases 1 to 3 and the R4 case.
Each fix's suite pair had no new per-test failure against its base (logs r60-r5-suites-r1, r60-r5b-suites-r1,
r60-r7-suites-r1, r60-r6c1-suites-r1). The 16-rollover play-through proofs that row 60 asked for were not finished:
the direction changed first.

### 13.2 Limits at the original Track X checkpoint

- **Case 4, install before adopt (R3):** the owner chose a known limit (option C). The case is `it.skip` with its
  reason. No shipped flow installs before the creator adopts, but the public API can export before adoption
  (`sealEpoch` serves, and `exportCreatorSuccessor` has no adoption precondition); row 61 then guarded serving.
- **W1 (row 68), RED 402c76a4:** a scope is classified at exactly one install, so an outside proof that arrives 3 or
  more installs later was never re-evaluated (triple miss, fence misses). Durable F2 and the shared Done rule now pass
  these cases, including an out-of-window restart (section 18). The original in-memory build (S3) passed the REDs but
  broke the pinned packages/node/tests/creator-journal-classification-compound.test.ts ("keptJournal is not
  defined"), so it was saved on branch track-x-s3-wip and is not on this branch. The owner chose storage S1.
- **Astra's A1 and A2 REDs (9e20b737)** originally failed: a partial Cut with a missing row and an expired source
  unrecognised at a later install. F1 resolves the missing membership; the shared settlement-completion owner
  recognizes genuine expiry without a replacement. Both native cases now pass (section 18).
- **P1** (skip the dependency census for a nonportable replacement) was measured, not committed: epoch-3 installs
  111/82/57 s against 6.1/12.9/13.2 s (logs/p1pair-pp1.log, load 44-63). Its refusal test
  (tests/track-x-nonportable-prepare-refusal.test.ts) is uncommitted. Without P1 an install costs about 0.4 to 3.5 s
  per rebased entry under load.

### 13.3 The completion contract (row 71) and its probes

<evidence>/track-x/CONTRACT.md defines when a late-arriving row is done, what still needs it, the deletion order and
the checks, with astra's review folded in (H1-H6) and amendment A-1. This was the working design at the original
checkpoint. Section 18 records the implemented F1/F2/Done portion; issuance-plan lifetime work remains a separate
joined owner. Two probes established the original failures:

- **D8, a removed then re-admitted Writer** (82d1a5cf, logs/r61-d8-probe-r2): the removed replica wedges (its install
  is refused, "creator historical issuance authority preparation failed"; every later reopen fails "chain-invalid"),
  while a fresh replica works and restarts its sequences at 0.
- **A-1, a pending manual review** (6558a699, logs/r61-a1-probe-r2): the census refuses the pending source
  ("creator recovery dependency hold unavailable:outbox-classification:7:displaced:published") at the 4th install and
  on every retry, and the lull refused the same way. The final continuation now keeps this source open and permits
  unrelated installs and collection, including after reopen (section 18).

## 14. Serve a sealed successor only after the creator adopts it (row 61)

**RED e032dd1e, fix 5bd36214.** The creator's successor material server answered a Writer's request as soon as the
creator had sealed and exported, before the creator itself had adopted. The fix, in v3-room.ts `serveSuccessor`, wraps
the material server: a peer is authorised only once the creator has adopted that successor (readiness included), and
the response to a request that arrives earlier is held per peer inside the server's own response deadline, then
released when `adoptCreatorSuccessor` settles. Exporting stays possible before adoption, and the storage-level exports
(`createCreatorSuccessorMaterialServer`, `readCreatorSuccessorExport`) stay unguarded (owner's choice, a known limit).

Proof: the RED and tests/track-x-successor-serving-gate-bounds.test.ts (bounded holds; chunks refused before
adoption) pass (logs/r61-gate-bounds-fix-r3) and fail at base (r61-gate-bounds-base-r1). Suite pair: no new
per-test failure (fix 49 failed, base 51; the two are the gate tests).

The gate had a limit: a request held past the Writer's 10 s window failed the whole install. Section 15 removes it.

## 15. The Writer's one install outwaits the gate (row 72, option E)

**RED 6604dff8, fix 2e813db5.** No wire change. Astra's consult 3 (<evidence>/astra-consult-3/answer.md) chose
it over an unsigned not-ready frame (forgeable by a hostile source to starve honest ones), a signed one (needs the
protocol-v3 whitelist) and a finite retry budget (only moves the cliff).

### 15.1 What changed

- **packages/node/src/internal/creator-successor-transport.ts.** `receiveCreatorSuccessorMaterial` takes an optional
  `retryUntil` signal. Without it, the fetch is one pass over the connected listed peers, as before. With it, each
  round re-reads the connected peers and tries each listed, connected, not-yet-terminal peer once, one attempt in
  flight, each attempt with a fresh nonce and its own `SNAPSHOT_PULL_INACTIVITY_MS` deadline (not raised). Between
  rounds it pauses 250 ms, doubling to 5 s (`CREATOR_SUCCESSOR_MATERIAL_RETRY_INITIAL_MS` / `_MAX_MS`, new; the
  snapshot 3-attempt constant is not reused). It ends when the material arrives, when every listed peer failed
  terminally, or when `retryUntil` aborts. There is no total deadline.
  - Each attempt (`attemptCreatorSuccessorMaterial`) is classified by where it failed. Opening, writing or reading
    the stream, its own deadline and the lifetime are transient. A signing failure not caused by an abort, and
    everything about the response (frame, kind, version, manifest, peers, nonce, author, signature, bounds), are
    terminal: that peer is not asked again. Uncertain stream cleanup ends the fetch at once, as before.
  - The diagnostic keeps one failure per listed peer (first-failure order), so its size is bounded by the peer list.
  - A server-side refusal is a stream abort, which the Writer cannot tell from a reset, so it is transient. A source
    that refuses for good, or holds every request, keeps the install waiting until the session closes. That is the
    accepted cost of no total deadline (row 72: the owner decides whether an install may stay pending until close).
- **packages/node/src/creator-adoption.ts.** `receiveCreatorSuccessorAdoption` passes `retryUntil` through.
- **packages/node/src/v3-room.ts.**
  - A session lifetime (`sessionLifetime`, `endSessionWaits`): `shutdown` and `closeSession` abort it right after
    marking the session closed, before `closeSession` awaits the install, and the install's receive passes it as
    `retryUntil`. So a close ends a waiting install promptly. Track Z's scheduled lull never reaches the receive
    (its lull runs `maintainRecipientRecoveryPool` / `maintainCreatorRecoveryPool` only), so nothing else needs it.
  - The gate (row 61) gets a serving generation. `cancelSuccessorServingHolds` bumps it and releases every hold; a
    held request of an older generation fails "creator successor serving is closed". Close and a serving replacement
    (`serveSuccessor`) cancel the holds before the port joins its handlers. Each response write first releases the
    holds of peers that are no longer connected (`releaseDisconnectedSuccessorServingHolds`). `successorAdopted` also
    requires an open session with no terminal failure.
  - A failure of the adoption tail's final `predecessorClose.stop()` now sets the terminal failure before serving can
    open (it was released before).

### 15.2 Tests and proof

The RED (6604dff8) has three new files and an amended bounds proof:

- tests/track-x-successor-material-retry.test.ts (20 tests, transport level): reset, ended stream, open failure and
  the attempt's own deadline are retried with fresh nonces; a peer not yet connected is waited for; nine terminal
  responses each make exactly one request; uncertain cleanup ends at once; fair rotation (a, b, a, b) with one stream
  in flight; a disconnected peer is skipped until it reconnects; the lifetime ends both the wait and an attempt in
  flight; listeners and diagnostics stay bounded.
- tests/track-x-successor-material-wait.test.ts (10 tests, native rooms): the one install outwaits a 22 s adoption
  delay (requests at 0, 10.3 and 20.8 s, one response after the adoption at 22.2 s); a request after adoption is
  served at once; Writer close, creator close (handlers joined) and serving replacement each end held work in 4 to
  6 ms; a failed adoption never opens serving; a creator restarted after adoption with a 12 s startup delay is
  outwaited; Writer restart; a disconnected peer's hold is released in 1 ms; same-peer supersession; no new frame
  kind on the wire.
- tests/track-x-successor-serving-gate-late-failure.test.ts: the final-stop failure is terminal and the held request
  fails.
- tests/track-x-successor-serving-gate-bounds.test.ts proof 2 now reads: each held attempt ends at the server's
  response deadline, and the one install continues and completes after the adoption. Proof 1 adds chunk requests.

RED: 10 unit and 9 native tests fail at 6604dff8's source (logs e-red-unit-r1, e-red-native-r1); three native tests
pass there on purpose (served at once, Writer restart, supersession). With the fix: 22/22 unit, 13/13 native including
the gate RED e032dd1e (e-fix-unit-r1, e-fix-native-r1). The hostile-response pin r9-grid-outcome-transfer-native
(3738-3744) passes unchanged (30 passed, 4 skipped; e-fix-pins-r1). The other pin, r9-chat-shipping-room-native
(714-724), fails before it reaches the pin at base and fix alike ("truncated canonical value" building the shipped
Chat genesis state), so it cannot run here; the transport tests cover the same refusals with one request each.

Why r9-chat-shipping-room-native fails here (so that the failure is not mistaken for a product failure later):

- **What it reads.** It reads no `.logs` input. Its only outside input is the catalog named by
  `SHIPPING_CHAT_CATALOG_DIR`. These runs point it at Track M's materialised catalog,
  <evidence>/track-m/sub-cc/chat-catalog. That catalog was written on 2026-10-20 at 05:10 and holds one blueprint,
  digest 61ab694a…, in the capacity format.
- **The failure.** The fixture calls `createShippingV3ChatApplication({ catalog, blueprintDigest })` with no
  `exactCanonicalGenesisLatchedAclBytes`. For a capacity-format artifact, examples/chat/src/v3-chat-application.ts:163
  then decodes an empty `Uint8Array` as the genesis ACL. The throw is at examples/chat/src/v3-chat-capacity.ts:189
  (logs r9-chat-shipping-catalog-r1).
- **What that makes it.** The test is out of step with Chat's current application input. It is not the room's
  behaviour.
- **Without the variable.** Every test fails at once with "SHIPPING_CHAT_CATALOG_DIR must name genuine nightly
  output" (r61 pair logs).

The completed E pair covers 44 files on both sides: 49 failed / 229 passed / 14 skipped with E, versus
67 failed / 211 passed / 14 skipped without it. Comparing the raw named failure headings finds no new named failure
and 18 resolved failures. The fixed run also reports a Vitest worker `onTaskUpdate` timeout, so neither side is a
clean full-suite pass. Logs: `e-pair-fix.log`, `e-pair-base.log`; the file manifest is `data/e-pair-all.txt`.
The earlier console-summary parser omits some fast tests, so its differing inventory counts are not a complete
per-test result set.

## 16. Recover a creator restarted between seal and adoption

The original restart probe met "v3 room trust installation failed: trust-rejected" when reopening the creator. The probe
tests/track-x-creator-reopen-pending-probe.test.ts (a831bdfa, a probe, not a RED) reopens the creator at each step:

| Creator stopped after               | Reopen                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| seal                                | fails, trust-rejected (cause: trust-state-inconsistent) |
| seal, export                        | fails, the same                                         |
| seal, export, a Writer install open | fails, the same                                         |
| seal, adoption                      | succeeds, epoch 1                                       |
| (no seal)                           | succeeds                                                |

It is not the fixture and not the gate. Room startup installs trust from the epoch-0 store, whose head now holds the
sealed successor's trust record, and the generic opener refuses that record by design ("leaving successor opening to
creator-close", tests/phase-5e-creator-close-red.test.ts:338-361). So a creator that crashes between seal and
adoption could not reopen its room. That was the original checkpoint's open item; it is resolved by 7c94ec35.

Startup now reconstructs the original local close through the existing adoption owner before opening a live plane.
The room's durable floor, original Cut/QC/trust, predecessor snapshot and journal replay must agree. The generic
trust opener remains strict. Certified archive appends still require the archive owner; ordinary local seals no
longer require an archive merely to restore their original adoption facts.

The native acceptance tests run four consecutive seal/stop/reopen cycles with and without a recipient already
waiting. Separate worker processes are killed with SIGKILL immediately after seals at epochs 0 and 2 while native
owners remain open; both reopen, preserve the durable projection, issue new work and roll over again. Native altered
Cut, stale read-view and fenced-source controls all refuse before head publication, and healthy reopen remains
possible afterward. Independent review found no actionable regression; node build/typecheck pass. The obsolete
historical adoption fixture fails before its authorization assertions because it lacks the current native membership
port, so that suite is not counted as passing. See the `creator-sealed-successor-*` native tests.

## 17. A migrated target skips the prime that can only decline (row 73, step 14 A)

**RED 8dd890ea, fix 73f780ff.** Astra's consult 4 (<evidence>/astra-consult-4/answer.md) verified the mechanism.
Its prototype is <evidence>/astra-consult-4/evidence/verified-a.patch, which was reverted.

### 17.1 The cost

After a migration, the creator's target runs epoch 0 with the migration source retained. Every ordinary admission
on it, local or received, first runs an OPTIONAL prime: creator-close.ts `captureCreatorOrdinarySourceWithoutForecast`,
called at close:3500 for the initial prime and at close:3514 for the joined-source refresh. That prime is one
complete cold read lifetime: seal dependencies, acquire a proof, capture, release.

On this target the capture always declines. The census carries `migrationSource`: the selection is at
v3-live.ts:11075-11076 and the insertion at 11841 (not 11133, as the step-14 note said). The data owner then refuses
any census with a migration source as "native-or-cross-context-source" (creator-closed-rollback-data.ts:5465-5466).
So each admission pays a lifetime that learns nothing, and then pays the mandatory cold quote. In Track V's
switched d9346 runs, maintenance start to prime result took 1.3 to 2.6 s per post-migration creator row, at load
40 to 91. The FIFO maintenance queue then serialises these rows.

### 17.2 What changed

- **packages/node/src/creator-close.ts.**
  - `V3CreatorCloseRegistration` gains an optional member, `hasMigrationSourceForOrdinaryPrime?(): boolean`, marked
    `@internal`. The root tsconfig strips internal members (`stripInternal`, which packages/node extends), so the
    published declarations do not carry it. The unit test emits the declaration in memory, with and without
    stripping, to prove that.
  - `captureCreatorOrdinarySourceWithoutForecast` reads the hint after its domain check, and only for a
    non-readiness call. When the hint is true, it reports `ordinary-incremental-source-prime-skipped`
    (`reason: "migration-source"`) and returns `undefined`. Nothing is sealed, acquired, captured, charged or
    released, so no credit is transferred.
  - A missing, false or throwing hint keeps the original route. Readiness priming (close:4727 and 4893 pass `true`)
    never reads the hint.
- **packages/node/src/v3-live.ts.**
  - `migrationDisplacedSource(registration)` is exactly `captureCreatorRecoveryRuntime`'s `migrationSource`
    selection. The unit test runs both sources over five cases and compares them.
  - The creator close registration answers the hint by calling it each time, so a reopen, a rollover or a replaced
    source shows at once.
  - `captureCreatorRecoveryRuntime` itself is untouched. Existing tests extract it into a sandbox with fixed
    bindings, and a new free identifier there would break them.

The hint can only skip a prime that would have declined. The census sets `migrationSource` whenever the runtime has
a migration source, and the hint is true only then, so a true hint always means a decline. No supported warm capture
is lost. Later warm capture is unchanged: the cold path's capture at close:3556-3558 still runs.

The claim is narrow on purpose. Healthy outcomes are unchanged, and every check of the mandatory cold quote stays.
Failures that only the skipped lifetime could raise (acquire, capture or release faults of that lifetime) are no
longer raised. The unit test pins this: the same faults still raise when the hint is false, and in readiness.

### 17.3 Tests and proof

**Unit test: tests/track-x-ordinary-prime-migration-skip.test.ts.** It runs the exact helper and the exact live
predicate, taken from source into a sandbox. Its eight tests check:

- the member is private (the in-memory declaration emit drops it when stripInternal is set and keeps it when not);
- a migration source skips the prime, for a received and an unreceived receipt alike: no seal, proof, capture or
  release, and the skip event is reported;
- readiness is never skipped;
- a missing, false or throwing hint keeps the original route;
- the hint is read at each call;
- outside the domain, the hint is not read;
- the narrowed claim: faults in acquire, capture, release, and capture-and-release raise nothing when skipped, but
  still raise when the hint is false and in readiness;
- `migrationDisplacedSource` equals the census's `migrationSource` selection over five cases.

**Native test: tests/track-x-ordinary-prime-migration-native.test.ts** (node SQLite room). The Writer joins the
migrated target the way d9346's joiner does: from the target's invite, with the creator's retained republication. It
checks:

- on the migrated epoch 0, every local and received row's prime is preceded by the skip event, none runs a declined
  lifetime, and all rows are admitted;
- readiness priming is still entered, and still declined by the data owner;
- a reopen at epoch 0 still skips; the rollover and a reopen at epoch 1 never do;
- with no migration, nothing is skipped and warm hits are unchanged;
- a corrupted census read inside the mandatory cold quote is refused, with the projection unchanged, and the same
  operation then succeeds.

The fixture gains a target's invite material, `open({ room, host })`, `deliver` and `republish`.

**Results.** These ran in a scratch copy, because the worktree was busy with option E's suite pair. The copy is a
copy of the worktree without .git and .logs, and its source was verified equal to HEAD.

| Run | Source | Result | Log |
| --- | --- | --- | --- |
| RED | 2e813db5 | 7 fail, 6 pass | a-red-copy-r2 |
| With A | 73f780ff | 13/13 pass | a-green-copy-r1 |
| Fixture users with the trimmed fixture | 73f780ff | 15/15 pass | a-green-copy-r2 |
| Node typecheck | 73f780ff | 0 errors | a-typecheck-node-copy |

**Suite pair.** A was run against 8dd890ea's source, 120 files at a 120 s timeout. No test failed with A that
passed without it among the named results captured by the comparison: 210 failed with A and 218 without
(`data/a-pair-compare.txt`). The raw totals differ by eight failures. The parser omits fast test lines and reports
different inventories, so it does not establish an eight-test one-to-one attribution; the dedicated RED/green run
above supplies that evidence.

The 120 files are A's surface pins, at the coordinator's request:

- d9346-v3-room-extraction-red's export pin. It shows the same pre-existing diff in both halves, and A adds no
  export.
- Every test that names `V3CreatorCloseRegistration`, or reads creator-close.ts or v3-live.ts as text, directly or
  through a fixture it imports. This includes the sandbox extractions in creator-closed-rollback-proof-accounting
  and creator-ordinary-readiness-producer, and the pinned creator-journal-classification-compound.
- The migration suites (phase-3h, r9 canvas/chat/grid) and the Track X room suites.

No pinned test needed an edit. packages/node/tests/authenticated-commit-packaging-1o-g-corrective-red is excluded
by the root vitest config, and A changes no package.json or export map.

### 17.4 Corrections and what A does not fix

- **Capacity refusals.** After the suffix is placed in the step-14 traces, every capacity refusal is on the joiner
  (context 1), not on the creator (context 0). s14p-1 has 16 joiner refusals, starting after +15 s, while the
  creator's suffix admission ended at about +9.9 s.
- **Cold fallback after the rollover.** It can persist for a different reason. On the creator's epoch 1 (all local
  rows), the native probe reports `ordinary-incremental-fallback` with `"failed":["fixedJournalShape"]`
  (creator-closed-rollback-data.ts:15332: "An all-local branch needs its own compiler"). A does not change this.
- **B is deferred** to its own design track: warm capture with a migration source. It needs authenticated
  cross-object source facts and fresh custody of both native contexts, and it touches G5, G10-G12, G21-G22 and G25.
- **The lost first copy is a separate new track.** Astra reproduced it natively: 39 rows, 7 first copies refused,
  and the missing hook sends nothing. A delivery repair that is peer-aware, bounded and progress-controlled belongs
  there. The pointer is kept in CONTRACT and here.
- **The 20 s poll stays** (no C).

### 17.5 d9346 with A

The uninstrumented loops `d9a-a.log` and `d9a-noa.log` each completed ten runs with both d9346 tests passing:
20/20 tests with A and 20/20 without A. These runs establish compatibility, not that A is necessary for success.

The later instrumented, interleaved ten-pair loop (`d9ab-probe.log`) passed 16/20 tests with A and 15/20 without A.
Both sides passed the first six pairs; later pairs encountered migration-delivery or first-test failures under very
high host load. That does not establish a reliable browser speedup or a statistically meaningful reliability change.

The first five instrumented pairs (`data/d9ab-probe-summary.txt`) do confirm the mechanism: all ten migrated-target
rows with A skip the declining prime, and none of the ten without A do. The measured median start-to-capture time
is 2.539 s with A versus 4.061 s without it, while the mandatory cold quote varies substantially with load. The
supported claim is the removal of the redundant native lifetime; the mandatory cold quote and delivery limitations
remain independently observable.

## 18. Durable received authority and one completion rule

F1 carries the creator's exact Cut membership to a recipient that never received every included row. The recipient
verifies it and adds only its own authenticated witnesses before persisting it. A missing committed local native row
still refuses; an absent remote row is not fabricated. This is why a partially received Cut can now leave the replay
window without accumulating permanent journal scopes.

F2 keeps the Cut, commit QC and successor trust beside that membership in the existing native journal carrier.
Those bytes are data. When the ordinary recovery window no longer supplies authority, the genuine held owner
reopens them against the immutable genesis and the original signed scope header. No in-memory authority registry
survives a lifetime. The existing recovery-window DATA path remains available, and the complete native image bound
charges the retained envelope. The owner is
[`creator-received-close-membership.ts`](../../../../packages/node/src/internal/creator-received-close-membership.ts).

The journal and recovery census use the same local completion owner in
[`v3-live.ts`](../../../../packages/node/src/v3-live.ts). An own row outside the Cut needs signed terminal coverage
and completed local settlement. A fence is intrinsically settled; expiry needs the exact source digest and the
immutable policy's expiry result; replacement work needs every durable chunk and the same policy-derived operations.
Manual review stays open. Replacement inclusion in a later Cut is not an extra completion condition. The journal
still authenticates the original row against its closed ACL and checks the original dependency rules.

An interrupted old-build installation can have persisted the unwrapped membership. The native upgrade permits only
an additive received envelope containing those exact old bytes. It retains native image currency, mutation fencing
and the whole-image ceiling, and refuses rewrites or downgrades. Both hosts use the same mechanical preservation
predicate in [`live-journal`](../../../../packages/live-journal/src/retirement.ts); protocol authority remains with
the held verifier.

The final native evidence covers delayed replacements through twelve epochs, fences that miss four Cuts and restart
after their authority leaves the recovery window, clean-scope crash boundaries, and expiry/rebase trajectories.
Resolved scopes return to the two replay scopes. A manual-review source survives ten epochs and a persisted reopen
while unrelated scopes collect. Genuine stored F2 records pass; altered Cut, QC, trust, scope, header or genesis
material is refused. The adversarial cases live with the native Track X tests rather than a second documented matrix.

The independent review found the interrupted legacy-record retry defect. Its new native reproduction passes after
the shared extension fix, along with SQLite and Chromium stale/changed/oversize/reopen controls. The compound lifetime
and accounting suite remains green, and all package builds and the proper node typecheck pass. The follow-up review
found no actionable regressions. Two unrelated ordinary-settlement-capacity test failures reproduce unchanged on the pre-F2 integration
baseline; a broad historical suite is not claimed green.

This result does not yet prove arbitrary repeated portable replacement chains have a bounded footprint. Their
remaining native source/plan consumers and atomic retirement are being joined by H5. The browser gameplay
continuation has a separate evidence owner; creator seal-to-adoption crash recovery is resolved in section 16. An offline recipient missing
at least two installs, and the same removed/re-admitted replica preserving an unresolved source, still need strong
acceptance assertions; the D8 observation probe is not a passing recovery proof. These conclusions must be added
before claiming the entire continuation complete.

Track J's [formal result](../38-track-j-late-arrival-retirement-model/RESULT.md) is integrated as 01d05d84. Its complete
finite graphs and mutation witnesses support the stated bounded model; they are not an unbounded eventual-delivery
theorem or a substitute for the remaining native rejoin and portable-chain gates.

Continuation logs are under `<evidence>/track-x/logs/`: `f2-window.log`, `f2-expire.log`,
`f2-outwindow-reopen.log`, `f2-upgrade-{unit,sqlite,browser}.log`, `f2-final-{build,typecheck}.log`,
`f2-review-final.log`, and `recovery-{seal-green1,sigkill1,refusal-native,review,final-typecheck}.log`.

## Commits

| Commit   | What                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 4122ab83 | test: measure the shipped Canvas and Chat pages as long rooms in Chromium          |
| 7cbbcaef | test: RED for the settlement fence that reaches a recipient before its install     |
| d48b57cd | test: RED for a lost creator move that the creator's next move needs               |
| 24699ced | fix: a recipient asks the creator again for a dependency it is missing             |
| 3e806aff | test: RED for a migrated Writer's settlement plan the census refuses               |
| f4c3c5c2 | fix: the issuance census classifies a migrated Writer's inherited plan             |
| f2d301d5 | docs: record the Track X result                                                    |
| 9b6b5f3f | test: RED for a settlement creator whose readiness waits for a subscriber          |
| 270c7068 | test: RED for a direct send that never completes                                   |
| 76ea48f2 | test: hang diagnostics for the Track X shipped-app harness                         |
| 4787390d | fix: a direct send that never completes cannot hold a room                         |
| d46c3e74 | test: IndexedDB/lock probe and a history-request storm for the harness             |
| a2ef638b | docs: record the Canvas harness hang                                               |
| e26cd812 | test: let pending history requests finish before the lost-move RED loses its move  |
| e1f471bb | test: RED for a creator seal that waits on its own live journal                    |
| 2a65f450 | fix: the creator seal stages before it takes a journal source                      |
| b8ad1f50 | merge: main 24d4ca61 into the seal deadlock work                                   |
| 75a16b81 | docs: record the seal deadlock fix                                                 |
| b9335db0 | docs: record the startup-order options                                             |
| 7256d607 | test: pin the v1 startup order with preparation before publication                 |
| f86f8a0a | fix: a settlement creator prepares readiness before its startup publication        |
| 83176da6 | test: red for a Writer's append that meets a creator's readiness preparation       |
| 04135190 | fix: a creator's readiness preparation holds arrivals until it ends                |
| 9f143f3b | test: pin the readiness ingress hold's gates, pool bounds, release paths and close |
| 0e7c068e | fix: keep enqueueV3Ingress's pinned closing-gate line under the readiness hold     |
| 4f5fc446 | merge: main ebf4254f into the row 51 work                                          |
| 23a569ac | docs: record decision row 51's implementation and proof                            |
| 2863424c | test: RED for a Writer that plays during the creator's seal or adoption            |
| 0a3cce4f | test: deliver the play-through RED's rows in flow-controlled batches               |
| bb357ac1 | fix: issue a Writer's nonportable settlement replacement without the portable prep |
| fc4bd2af | test: RED for a nonportably replaced source at the Writer's recovery turnover      |
| e47f6b8b | fix: recognize a completed nonportable settlement replacement in the census        |
| 04a59a33 | test: an opt-in play-through-rollover mode for Track V's Grid harness              |
| 357ddea2 | test: RED for a Writer whose journal scopes with a replaced move stay protected    |
| daf61067 | fix: collect a Writer's journal scope whose outside moves it replaced              |
| 0699bcf3 | merge: main 0171994d into the row 60 work                                          |
| 13793d94 | test: RED for journal scopes that keep another Writer's move made during the seal  |
| 986e1d05 | fix: collect a received move outside the Cut once the successor install is durable |
| 77ffef9a | test: RED for a replacement of a move made during the seal that missed the Cut too |
| 128b066e | test: RED for a settlement fence, or whole install output, that missed the Cut     |
| b8268291 | fix: collect a Writer's settlement fence outside the Cut after a later own fence   |
| 4cbef3d7 | fix: recognize a completed replacement of a source older than the closed epoch     |
| 6f37faae | fix: follow a replaced move's replacement that missed its own Cut too              |
| 402c76a4 | test: RED for outside rows that resolve after the classification window (W1)       |
| 9e20b737 | test: RED for astra A1 (partial Cut) and A2 (expire policy)                        |
| 82d1a5cf | test: probe a removed then re-admitted Writer (CONTRACT D8)                        |
| e032dd1e | test: RED for serving the successor only after the creator adopts it (row 61)      |
| 5bd36214 | fix: serve a sealed successor only after the creator has adopted it (row 61)       |
| 6558a699 | test: probe a pending manual review's effect on installs and the lull (A-1)        |
| 6604dff8 | test: RED for option E, the one install outwaits the serving gate (row 61)         |
| 2e813db5 | fix: a Writer's install retries its material fetch until the session closes (E)    |
| a831bdfa | test: probe a creator reopen while its sealed successor is pending (probe)         |
| 8dd890ea | test: RED for skipping the declining prime on a migrated target (row 73, A)       |
| 73f780ff | fix: a migrated target skips the optional prime that can only decline (A)         |
| 19ce52a2 | fix: terminally reject framing-bound violations while retrying transient resets |
| fd342d90 | fix: persist received authority and share the local settlement-completion rule |
| 7c94ec35 | fix: reconstruct sealed local adoption before room startup |
| (this)   | docs: preserve original E/A evidence and record the verified continuation |

Main (24d4ca61) carries f2d301d5, the fixture half of 9b6b5f3f (65505659) and 270c7068..e26cd812 as picked
commits (eeddd65a..cf6d306f). The startup RED file of 9b6b5f3f stays on this branch. Main (ebf4254f) also carries
e1f471bb, 2a65f450, 75a16b81 and b9335db0 as picked commits (04f7fd0b..9b28e327).
