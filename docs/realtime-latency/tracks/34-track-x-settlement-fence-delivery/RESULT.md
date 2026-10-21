# Track X: the settlement fence that reaches a recipient before its install

Worktree: <worktree agent-a9ab847b594d95e7f>/
Branch: worktree-agent-a9ab847b594d95e7f (rebased onto main 725f291b; main 24d4ca61 merged in at b8ad1f50)
Evidence: <evidence>/track-x/ (PROGRESS.md, logs/, tests/, bench/, bin/, data/, trash/).

On the `creator-trusted-settlement-v1` profile, with real networking in Chromium, the creator's moves stopped reaching
the other peer after the fourth successor (Track V, Grid). Track X found the cause, fixed it in the library, and looked
at Track V's two d9346 failures.

## Summary

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

## Commits

| Commit   | What                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 4122ab83 | test: measure the shipped Canvas and Chat pages as long rooms in Chromium         |
| 7cbbcaef | test: RED for the settlement fence that reaches a recipient before its install    |
| d48b57cd | test: RED for a lost creator move that the creator's next move needs              |
| 24699ced | fix: a recipient asks the creator again for a dependency it is missing            |
| 3e806aff | test: RED for a migrated Writer's settlement plan the census refuses              |
| f4c3c5c2 | fix: the issuance census classifies a migrated Writer's inherited plan            |
| f2d301d5 | docs: record the Track X result                                                   |
| 9b6b5f3f | test: RED for a settlement creator whose readiness waits for a subscriber         |
| 270c7068 | test: RED for a direct send that never completes                                  |
| 76ea48f2 | test: hang diagnostics for the Track X shipped-app harness                        |
| 4787390d | fix: a direct send that never completes cannot hold a room                        |
| d46c3e74 | test: IndexedDB/lock probe and a history-request storm for the harness            |
| a2ef638b | docs: record the Canvas harness hang                                              |
| e26cd812 | test: let pending history requests finish before the lost-move RED loses its move |
| e1f471bb | test: RED for a creator seal that waits on its own live journal                   |
| 2a65f450 | fix: the creator seal stages before it takes a journal source                     |
| b8ad1f50 | merge: main 24d4ca61 into the seal deadlock work                                  |
| (this)   | docs: record the seal deadlock fix                                                |

Main (24d4ca61) carries f2d301d5, the fixture half of 9b6b5f3f (65505659) and 270c7068..e26cd812 as picked
commits (eeddd65a..cf6d306f). The startup RED file of 9b6b5f3f stays on this branch.
