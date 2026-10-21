# Track X: the settlement fence that reaches a recipient before its install

Worktree: <worktree agent-a9ab847b594d95e7f>/
Branch: worktree-agent-a9ab847b594d95e7f (rebased onto main 725f291b)
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

## Commits

| Commit   | What                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| 4122ab83 | test: measure the shipped Canvas and Chat pages as long rooms in Chromium      |
| 7cbbcaef | test: RED for the settlement fence that reaches a recipient before its install |
| d48b57cd | test: RED for a lost creator move that the creator's next move needs           |
| 24699ced | fix: a recipient asks the creator again for a dependency it is missing         |
| 3e806aff | test: RED for a migrated Writer's settlement plan the census refuses           |
| f4c3c5c2 | fix: the issuance census classifies a migrated Writer's inherited plan         |
| (this)   | docs: record the Track X result                                                |
