# Track Q: Canvas and Chat creator lull

Worktree: <worktree agent-afc8a0b30ff709f24>/
Branch: worktree-agent-afc8a0b30ff709f24, rebased onto codex/phase3a1b-p6-golden-path at 19caa468 (Track S's
merge). The first version of this track was built on c67c66b7 and was held on a pre-existing reopen bug that
Track S has since fixed (section 8).
Commits: see "Commits" at the end. Evidence: <evidence>/track-q/ (PROGRESS.md, BOUND.md, logs/, data/, browser/,
grid/, tests/, bin/).

`CC` = packages/node/src/creator-close.ts. `CCRD` = packages/node/src/internal/creator-closed-rollback-data.ts.
Line numbers are at 19caa468.

## Summary

- **Problem (Track M finding 14):** the shipped Canvas and Chat compositions did not supply
  `readOrdinaryApplicationResourceBound`. `maintainRecoveryPool()` answered `deferred:unsupported` at every
  epoch, so the creator's recovery-pool retirement ran inline at seal: 4 retirement selections per seal from
  epoch 5.
- **Change:** each composition now supplies the reader. The value is one rule applied to each application's own
  reviewed limits: a canonical footprint that dominates every state the application's own capture accepts,
  taken only from limits that capture enforces.
  - Canvas: the exact footprint of the widest admitted state at the composition's dimensions. At 10×10 that is
    {2944 bytes, 817 items, depth 3}.
  - Chat: the 32 KiB capture ceiling, {32768, 16384, 16}.
  - Nothing in the room, the lull, retirement, admission or the Grid changed.
- **Chromium, real IndexedDB, room path, 8 rollovers, 3 ABBA pairs, base 19caa468 against this branch**
  (shipped Canvas now runs Track T's `creator-trusted-settlement-v1`):
  - seal 191–229 ms against 1902–2065 ms (0.09–0.12×), with 0 retirement selections against 16 per run;
  - adoption is slower: Canvas 563–588 ms against 334–372 ms, Chat 601–618 ms against 358–395 ms;
  - seal plus adoption, the rollover's critical path, is 763–961 ms against 2236–2448 ms (0.32–0.42×);
  - the longest main-thread task per epoch: Canvas has none of 50 ms or more in any steady epoch (base: up to
    70 ms); Chat p50 128–146 ms against 280–315 ms (max 149 against 505);
  - per-move latency is unchanged or slightly lower.
- **Node SQLite, 16 epochs, persisted reopen after epoch 8, shipped against the same composition without the
  reader:** the creator lull is maintained at every epoch from 4 to 16; seal 178–296 ms against 1655–2816 ms
  (0.08–0.12×), 0 retirement selections against 44 per run; adoption 459–1026 ms against 284–544 ms; seal plus
  adoption 0.24–0.44×; moves delivered during the lull are all admitted after it, in order (G23, 13 of 13
  maintained epochs per run); play continues after the reopen.
- **Persisted reopen right after the first maintained lull** (after epoch 4) now plays on, on the Node and room
  hosts, for both applications (Track S's fix). R3's "(4 rollovers)" test passes at this branch.
- **Grid:** unchanged. Its bundle is byte-identical at base and at this branch (sha256 f0afa06d…), and an
  8-rollover LULL=1 run passes with the shipped Grid lull pattern (section 6).
- **Suites against 19caa468, per test:** no new failure in any set (the six Canvas/Chat native tests,
  storage-node retirement, packages/node, and 117 root files including the K, L, N, R3, P, M, M2, O and S
  tests); the only differences are this track's 15 RED tests, fixed. `pnpm -r typecheck`: 0 errors.
- **Review:** both bounds need the repository owner's review (next section).

## Bounds for owner review

Plain-language summary of what each bound is, where its numbers come from, and what happens at the edges.

**What a bound is for.** The creator's recovery-pool lull runs only for an application that supplies an
"ordinary application resource bound": an upper limit on the size of any state the application can reach,
measured as canonical bytes, decoder items and nesting depth. In the shipped flows the room only checks that the
bound exists; it never calls it. A configuration that prepares incremental readiness (an application that also
supplies `createIncrementalProjection`) would call it and size a finishing reservation from it. So the value must
be at least as large as any real state (G22: the reservation must cover the actual effect), and it must come from
limits the application already enforces, not from measurements (G21).

**Canvas** (`createV3CanvasApplication(width, height)`, packages/node/src/applications/canvas.ts)

- Values: {byteLength, items, maxDepth} = 2944, 817, 3 at 10×10 (examples/canvas). Others: 1×1 73/25/3, 2×2
  160/49/3, 64×32 59438/16401/3, 64×64 118831/32785/3.
- Derivation: a Canvas state is a fixed-shape record: version, width, height, and one [r, g, b] counter triple
  per pixel. Only the integer widths vary, and the widest integer the application admits is
  `Number.MAX_SAFE_INTEGER` (`CANVAS_LIMITS.maxCounter`; admission refuses at the ceiling). The bound is the
  exact canonical size of that widest state, computed with the codec's own size arithmetic. Tests show it equals
  the encoded widest real state and dominates every state reached by random admitted moves. It lies inside the
  snapshot codec law the Canvas descriptor already documents (`CANVAS_SNAPSHOT_LIMITS`).
- If exceeded: a Canvas state cannot exceed it. The application's capture refuses any state of another shape,
  and admission refuses a counter past `MAX_SAFE_INTEGER`. If the bound itself exceeds the room's generic envelope
  (more than 16,384 items, which happens above 2,045 pixels), the room's consumer refuses the value and takes the
  original exact path. That costs only speed; such a canvas cannot fit the generic state machine anyway.
- Serves G21 (bounded work from existing reviewed limits: `CANVAS_LIMITS` and the codec law) and G22 (the value
  dominates every reachable state, so a reservation sized from it covers the real effect).

**Chat** (`createShippingV3ChatApplication`, examples/chat/src/v3-chat-application.ts)

- Values: {32768, 16384, 16}.
- Derivation: these are exactly the limits Chat's own state capture enforces on every state
  (`captureShippingChatCapacityState` encodes under `LIMITS`: the reviewed 32 KiB retained-state bound
  `SHIPPING_CHAT_RETAINED_BYTES`, 16,384 items, depth 16). The value is those limits verbatim, now exported as
  `SHIPPING_CHAT_CAPACITY_STATE_LIMITS` without changing them.
- If exceeded: a Chat state cannot exceed it while the composition's admission policy
  (`createShippingChatCapacityAdmissionPolicy`, installed by the shipped Chat at examples/chat/src/index.ts:291)
  is in place. The policy refuses any message or batch whose complete joined state fails that capture, and the
  projection throws on any state over the ceiling. A host that composes Chat without that policy already breaks
  Chat's own invariant; the reader's comment says so.
- Serves G21 (the value is an existing reviewed limit, not a measured constant) and G22 (every state passes the
  capture, so the value dominates).

**In both cases**

- The reader answers only for its own composition. It checks the exact catalog entry and that every base state
  restores through the application's own capture; for anything else it returns `undefined`, and the room takes
  the original exact path.
- A bound that is too large only makes the room's consumer refuse the shortcut. A bound that is too small would
  under-reserve. That is why the rule is domination, and why it must be reviewed.
- Neither bound changes a limit, an admission rule, a retirement decision or a proof charge.
- Review status: the inputs are existing reviewed limits. The derivations themselves (Canvas's widest state;
  "every Chat state passes the capture") are new in this track and reviewed only by its tests. They need the
  owner's review before any configuration consumes the value (for example by adding
  `createIncrementalProjection`, which this track does not do).

## 1. What the bound must express (BOUND.md)

Full text: <evidence>/track-q/BOUND.md, rechecked at 19caa468 (the contract, consumers and inputs are
unchanged). In brief:

**Contract.** `V3RoomApplication.readOrdinaryApplicationResourceBound` (packages/node/src/v3-room.ts:460) is an
optional, pure, artifact-bound local planning bound. It is not shared validity or admission. Its type is
`CreatorOrdinaryApplicationResourceBoundReader` (packages/node/src/internal/runtime-reclamation.ts:195-257).
`v3-room.ts:4156-4157` passes it to the creator only.

**It bounds** the canonical footprint {byteLength, items, maxDepth} of any application state the complete
material can produce: any authenticated base, after any of the current, protected and recovery operations and
the candidate. It is an upper bound: the planner may only over-reserve.

**Consumers.**

- _By presence_, without calling it:
  - the lull gate (CC:4809-4811);
  - the explicit readiness boundary (`prepareOrdinaryReadiness`, CC:4670-4791);
  - the optional ordinary-source capture and refresh (CC:2460-2547);
  - the ordinary issue path's incremental quote attempt (CC:3487-3513).
- _By value_: `deriveCreatorOrdinaryApplicationResourceForSizing` (CCRD:4850).
  - It accepts only byteLength ≤ maxSnapshotBytes, items ≤ 16384 and depth ≤ 16, and re-decodes every base state
    under the value.
  - It runs only once readiness is _prepared_, which needs `createIncrementalProjection`
    (`creatorOrdinaryIssuanceSourceReadinessPrepared`, CCRD:4332; `prepareCreatorOrdinarySourceReadinessForSizing`,
    CCRD:5750). Neither composition supplies one, so the shipped flows never call the reader. Its value must still
    be sound for any configuration that does.

**Failure modes.** Too large: the planner misses and the exact path runs (speed only). Too small: it
under-reserves, which breaks G21 and G22. So the one requirement is domination.

**The Grid's value** (examples/grid/src/v3-zone.ts, `placementGrowthProjection` in zone-state.js) depends on the
material, because zone state has no ceiling of its own. It is reviewed by tests/phase-3g-chat-zone-rebase-red.test.ts
and packages/node/tests/creator-ordinary-neutral-resource.test.ts, and by R8's receipt
(specs/bounded-storage-lifecycle/requirements-to-evidence.md:692-720, 820-828).

**The rule** (G21, G27). An application's bound is a canonical footprint that dominates every state the
application's own capture accepts, computed only from limits that capture enforces. The Grid's capture enforces no
ceiling, so its theorem counts the material. The Canvas and Chat captures each enforce a fixed ceiling, so their
theorem is that ceiling. No product-wide constant is introduced.

**examples/v3-chat** (the demo Chat) is not changed: its state is an unbounded message list with no application
ceiling, so it would need a material-dependent theorem like the Grid's. Track V owns that example now.

## 2. The change

Commit 17eb3afa.

- **packages/node/src/applications/canvas.ts**
  - New module helpers: `resourceDataRecord` and `resourceBoundBases`, with the constants
    `RESOURCE_IDENTITY_KEYS`, `RESOURCE_CARRIER_KEYS` and `RESOURCE_MATERIAL_KEYS`.
  - `createV3CanvasApplication` computes the widest footprint once with `canonicalPrimitiveResourceForSizing`,
    `canonicalArrayResourceForSizing` and `canonicalRecordResourceForSizing` under `CANVAS_SNAPSHOT_LIMITS`.
  - It returns `readOrdinaryApplicationResourceBound`. The reader:
    - accepts only the composition's own resolved catalog entry (five identity strings and both byte carriers,
      copied at composition, own data properties only, as the Grid's `captureResourceMaterial` checks it);
    - accepts only a non-empty dense list of base states, each restoring through the descriptor's `restoreState`
      at the composition's dimensions;
    - returns a fresh frozen `{byteLength, items, maxDepth}`, or `undefined` for anything else (the original
      exact path).
- **examples/chat/src/v3-chat-application.ts**
  - The same two helpers.
  - `createShippingV3ChatApplication` returns a reader with the same checks. Its bases must restore through
    `restoreShippingChatCapacityState`, and its value is the capture limits.
- **examples/chat/src/v3-chat-capacity.ts**
  - `export const SHIPPING_CHAT_CAPACITY_STATE_LIMITS = LIMITS;` (no value change).

Neither reader inspects operations or runs a reducer, and neither retains anything. The doc comments carry the
derivation (G21) and the statement that the value grants no validity, admission, authority or credit. The rebase
onto 19caa468 had no conflicts; Track T's Canvas change is in examples/canvas (profile, invite), which this track
does not touch.

## 3. Tests

### 3.1 RED (committed first, ff22665c)

- **tests/canvas-chat-resource-bound.test.ts** (unit, 13 tests). For each application:
  - the shipped composition supplies a reader with no incremental projection;
  - Canvas at 1×1, 2×2, 10×10, 64×32 and 64×64: the bound equals the exact `canonicalCarrierResourceForSizing`
    of the encoded widest state;
  - the bound dominates every state reachable by admitted moves, including at the counter ceiling (Canvas: more
    than 300 reachable states; Chat: grown states up to the 32 KiB capture, and one message over the ceiling must
    throw);
  - the bound depends only on the composition, never on the operations or the candidate;
  - the reader refuses a foreign catalog, a mutated carrier, a missing field and any base that is not this
    composition's own state.
- **tests/canvas-chat-creator-lull-native.test.ts** (native, 2 tests): the shipped Canvas (receive-only
  recipient) and Chat (Writer recipient) on the Node SQLite host through 6 epochs. Requirements:
  - from epoch 3 the creator lull is never deferred, and it maintains at least twice;
  - a maintained lull runs retirement selection;
  - a seal after a maintained lull runs none.

On the original base: unit 13/13 fail (<evidence>/track-q/logs/red-unit-1.log), native 2/2 fail
(<evidence>/track-q/logs/red-native-1.log): every lull `deferred:unsupported`, the seals of epochs 5 and 6 run 4
retirement selections each. In the suite run at 19caa468 they fail the same way (section 7).

### 3.2 GREEN

At this branch after the rebase (<evidence>/track-q/logs/rebase-focus-1.log, load 129): unit 13/13, native 2/2.

### 3.3 Long-room evidence harness

tests/canvas-chat-long-room.test.ts runs only with `CANVAS_CHAT_LULL=1`; its browser twin is
tests/fixtures/canvas-chat-lull/browser/long-room.pw.ts. It covers Canvas and Chat; the node, room and browser
hosts; receive-only and Writer recipients; `shipped` against `absent` (the same composition with only the reader
removed); and an optional persisted reopen. Canvas takes its genesis profile and latched ACL version from
examples/canvas/src/profile.ts (`CANVAS_GENESIS_PROFILE`, Track T), so it runs `creator-trusted-settlement-v1`
as shipped; Chat runs the same profile.

Per epoch it asserts:

- G23: every row delivered during the lull, and the creator's own move, was admitted, and delivered rows were
  admitted in order;
- a lull that selected retirement had the moves handed to it while still running;
- `absent` is always `deferred:unsupported`; `shipped` is never deferred from epoch 3;
- no seal after a maintained lull runs retirement, except the first seal after a reopen, which is reported
  (section 5.3).

Ingress during the lull is triggered from inside it: `lullWithIngress` subscribes to the role's proof events,
starts `maintainRecoveryPool()`, and when the lull's own `closed-retirement-selection` fires it hands the peer's
signed rows to the room's ordinary ingress synchronously and issues one local move. (The Node host's lull is
synchronous `DatabaseSync` work, so a timer-based delivery would fire only after it.) Chat's Writer recipient
publishes the settlement author fence (`$drp.author-fence.v1`) before its moves; the creator admits it without an
`onAcceptedVertex` notification, so it counts as admitted when a reported delivered row depends on it.

Rebase additions (measurement only): the harness takes Canvas's shipped profile (74801275); a persisted reopen
works on the browser and room hosts too, by reopening the same databases (74801275); the browser harness can
alternate prebuilt base and head bundles (`CANVAS_CHAT_LULL_PREBUILT_ASSETS`, `CANVAS_CHAT_LULL_REPEAT_FROM`,
f4919f12).

## 4. Guarantees

- **G21 (bounded work, reviewed limits):**
  - Both values come from limits the applications' captures already enforce (`CANVAS_LIMITS` and the snapshot
    codec law; Chat's 32 KiB `LIMITS`). None comes from a measurement.
  - The lull is the existing bounded lull. The creator's own comment says it runs "the SAME original
    reconciliation at a quiescent lull" with "the close's inline maintenance … as the hard-cap backstop"
    (CC:4801-4803), and neither is changed.
  - Where the value is consumed, the consumer still enforces the generic envelope and re-decodes every base.
- **G22 (proof budget and charges):**
  - No charge, budget or reservation changed.
  - The readers grant nothing. Domination, the only property a consumer relies on, is tested: equality with the
    widest real state, domination of reachable states, and Chat's capture ceiling.
  - Same retirement in a different window: 4 retirement selections per maintained epoch with the reader, 4 per
    seal without it (Chromium: 20 in lulls at epochs 4–8 against 16 at seals 5–8; the lull starts one epoch
    earlier, at epoch 4's quiescent point instead of epoch 5's seal).
- **G23 (ingress during a deferrable lull queues FIFO, nothing dropped, provenance rechecked):**
  - In every epoch whose lull selected retirement, the moves were delivered while the lull ran: entered and
    pending in 5 of 5 maintained epochs in every Chromium run and 13 of 13 in every 16-epoch Node run. Every delivered row and the creator's own
    move were admitted, delivered rows in delivery order, both after the lull settled.
  - Rows enter through the room's ordinary authenticated ingress (`setIngressHandler`), so provenance is
    rechecked at admission by the unchanged path.
- **G26 (no trade for speed):**
  - No check was removed and no limit loosened. The retirement decision is the same work, moved to the lull.
  - Stored rows: after each lull, shipped holds fewer rows than base, because retirement already ran. Both reach
    flat creator stores. In Chromium, from epoch 6 the creator holds 142 rows (Canvas) and 155 (Chat) against
    176 and 194 at base; the issuance outbox is flat at 18 rows in both arms (Track P and settlement).
- **G27 (no game-specific carve-outs):**
  - One rule, stated in each reader and in BOUND.md, applied to each application's own reviewed limits.
  - Canvas and Chat use the same optional application field the Grid uses. The room, the lull and the consumers
    have no application-specific branch, and no product-wide constant was added.

## 5. Canvas and Chat: before and after

### 5.1 Chromium, real IndexedDB, room path, 8 rollovers: base 19caa468 against this branch

Data: <evidence>/track-q/browser/pairs-2/ (data/, pairs.txt from bin/pairs.py, table.txt from bin/table.py);
per-invocation runs in <evidence>/track-q/browser/pairs-2-r{0,1,2}-{head,base}/.

Method:

- two bundles built from the same worktree: base = the three product files written at 19caa468
  (<evidence>/track-q/browser/bundle-base-2, ccl-entry.js sha256 2cccdda1…), head = this branch
  (bundle-head-2, sha256 2d2b84e5…); identical input lists;
- one playwright invocation per arm, ABBA: head, base | base, head | head, base;
- base runs as `absent` (it has no reader to remove), head as `shipped`;
- the shipped Canvas (10×10, receive-only recipient, settlement profile) and Chat (Writer recipient), two pages on
  two origins, 2 moves per Writer per epoch plus 2 recipient moves and 1 creator move during each creator lull;
- 12/12 runs pass; load 10–14;
- medians over epochs 4–8.

Each cell lists head/base for repeats 0, 1 and 2; times in ms.

| Measure                                    | Canvas, receive-only                | Chat, Writer                                            |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------- |
| Seal                                       | 229/1946, 193/1902, 191/1974        | 195/2065, 214/1930, 201/2063                            |
| Seal retirement selections (Σ, epochs 4–8) | 0/16, 0/16, 0/16                    | 0/16, 0/16, 0/16                                        |
| Creator adoption                           | 588/360, 571/334, 563/372           | 618/395, 613/358, 601/385                               |
| Seal + adoption                            | 827/2341, 763/2236, 781/2329        | 826/2428, 961/2279, 783/2448                            |
| Recipient install                          | 148/176, 183/152, 159/154           | 252/251, 273/248, 262/247                               |
| Creator lull (base does not run one)       | 1895, 2031, 1951                    | 1894, 1922, 1996                                        |
| Recipient lull                             | 760/796, 793/745, 762/873           | 990/918, 952/936, 999/916                               |
| Creator issue / move                       | 213/268, 208/229, 200/255           | 93/104, 94/100, 87/103                                  |
| Recipient issue / move                     | (receive-only)                      | 22/21, 23/21, 23/23                                     |
| Creator admits a remote move               | (receive-only)                      | 90/107, 97/100, 96/104                                  |
| Recipient admits a remote move             | 3/3, 3/3, 3/3                       | 5/5, 5/5, 5/5                                           |
| Longest task per epoch, p50 (max)          | 0/0 (0/67), 0/0 (0/66), 0/51 (0/70) | 130/315 (136/505), 128/282 (134/447), 146/280 (149/450) |
| Creator lull maintained                    | 5 of 8 / 0 of 8 each                | 5 of 8 / 0 of 8 each                                    |

Notes:

- **Seal and adoption separately.** Seal drops to 0.09–0.12× because retirement left it. Adoption rises by
  190–255 ms (1.5–1.7×): the adoption boundary now runs the cold ordinary-source capture that base runs at the
  epoch's first move (section 5.4). Both arms include Track T's settlement pruning at adoption
  (`cleanupCreatorSettlementSuccessor`, packages/node/src/v3-live.ts:20280); compared with the pre-Track-T
  measurement (Canvas base adoption 202–224 ms), base adoption is now 334–372 ms.
- **Long tasks** are read per page per epoch (PerformanceObserver `longtask`, threshold 50 ms; 0 = no long task).
  Base Canvas's inline seal retirement produced 50–70 ms tasks; with the lull Canvas has none. Chat's longest
  task halves.
- **Per-move latency** is the same or slightly lower with the reader (ratios 0.78–1.10).
- **Lull-time moves (G23).** With the reader, the creator's own lull-time move completes 1789–1950 ms (Canvas)
  after delivery, and Chat's delivered remote rows are admitted 2707–2864 ms after delivery: they wait for the
  lull, as Track A's design states (v3-room.ts:630-636). At base the lull answers at once, and the same moves take
  237–287 ms (Canvas) and 1534–1856 ms (Chat, which includes the epoch's first-move source capture). How long
  the lull takes is Track M's subject.

### 5.2 Node SQLite, 16 epochs

Data: <evidence>/track-q/data/node-pairs-2/ (log <evidence>/track-q/logs/node-pairs-2.log; summaries
node-pairs-2.txt from bin/pairs.py and node-pairs-2-table.txt from bin/table.py).

Setup:

- this branch only: `shipped` against `absent` (the same composition with only the reader removed, which is the
  base composition; section 5.1 compares against the base tree itself);
- 2 moves per Writer per epoch, plus 2 Writer-recipient moves and 1 creator move during each creator lull;
- 300 ms settle before seal; persisted reopen after epoch 8;
- 1 ABBA pair (2 runs per arm) per case; 16/16 runs pass; load 14–60.

Medians over epochs 4–16, excluding the first epoch after the reopen. Each cell lists shipped/absent for repeat
0, then repeat 1; times in ms.

| Case                 | Seal               | Seal retirement (Σ) | Adoption          | Seal + adoption     | Install          | Creator lull (shipped only) | Creator issue / move |
| -------------------- | ------------------ | ------------------- | ----------------- | ------------------- | ---------------- | --------------------------- | -------------------- |
| Canvas, receive-only | 190/1655, 178/2190 | 0/44, 0/44          | 459/288, 486/368  | 639/1934, 663/2605  | 84/90, 93/103    | 1745, 1732                  | 179/229, 207/336     |
| Canvas, Writer       | 184/1764, 198/2566 | 0/44, 0/44          | 488/298, 538/395  | 670/2047, 745/3046  | 148/143, 157/197 | 1716, 2146                  | 107/108, 113/150     |
| Chat, receive-only   | 296/2816, 189/1784 | 0/44, 0/44          | 1026/544, 489/297 | 1360/3360, 673/2090 | 178/181, 99/102  | 3435, 1688                  | 446/451, 191/249     |
| Chat, Writer         | 252/2061, 188/1690 | 0/44, 0/44          | 792/325, 483/284  | 1035/2369, 661/1958 | 234/186, 163/166 | 2121, 1613                  | 176/138, 110/116     |

Results:

- **Lull ran each epoch.** Shipped: `deferred:unsupported` at epochs 1–2 (the lull's own floor,
  `currentEpoch < 3`, CC:4810), `not-needed` at 3, `maintained` at 4–16 with 4 retirement selections each.
  Absent: `deferred:unsupported` at all 16 epochs.
- **Seal no longer includes retirement:** 0.08–0.12×, with 0 selections.
- **Adoption** rises by 118–482 ms (section 5.4). Seal plus adoption is still 0.24–0.44×.
- **Per-move latency** shows no consistent direction: shipped/absent creator issue 0.62–1.28, recipient issue
  0.94–1.29, creator admitting a remote move 0.77–1.30.
- **Creator lull per epoch** is flat with room age: 1.4–2.2 s in most epochs, with load spikes up to 5.2 s
  (`latency.creatorLull` in the shipped JSONL files).
- **G23.** In all 13 maintained epochs of every shipped run the moves were delivered while the lull ran (entered
  and pending), and every delivered row and the creator's own move were admitted after it, delivered rows in
  order. The creator's own lull-time move completed 1641–3361 ms after delivery (absent: 241–2340 ms).

### 5.3 Persisted reopen

**Right after the first maintained lull (after epoch 4), node and room hosts.** Data:
<evidence>/track-q/data/reopen4-rebase-1/ (summary reopen4-rebase-1.txt, log logs/reopen4-rebase-1.log); 6 epochs,
both applications, both recipients, shipped and absent: 16/16 pass.

- Shipped: `deferred:unsupported` at epochs 1–2, `not-needed` at 3, `maintained` at 4, reopen, then
  `maintained` at 5 and 6. State and installed authority are equal across the reopen.
- The first seal after the reopen runs 1 retirement selection (371–2287 ms) against 4 without the reader
  (1223–5784 ms). The seal after that runs 0.
- This was the case that failed before Track S's fix (section 8); R3's "(4 rollovers)" test, which drives it on
  the room host with Canvas 2×2, passes at this branch.

**After epoch 8 (Node host, section 5.2):** in all 16 runs both roles were closed and reopened from their
stores, state and installed authority were equal, and play continued to epoch 16. The first seal after the reopen
ran 1 retirement selection (415–1307 ms) against 4 without the reader (1726–3565 ms); every later seal ran 0.
Reopen took 842–1435 ms shipped against 395–964 ms absent (one sample per run).

Why one selection after a reopen: the lull's early-turnover token (CC:3409-3410, set at CC:4869) is in memory
and does not survive the reopen, so the first seal discharges that epoch's planned retirement. With a reader, the reopened creator's
startup also runs the readiness capture an adoption boundary runs (`prepareCurrentCreatorOrdinaryReadiness`,
v3-room.ts:5667-5687), so reopen is slower.

### 5.4 Why adoption is slower

Data: <evidence>/track-q/data/kinds-1/ (6-epoch run recording every proof-event kind per window, commit 08e416e6,
measured before the rebase; the mechanism is room code that the rebase did not change).

With the reader present, the adoption boundary runs the cold ordinary-source capture
(`captureCreatorOrdinarySourceWithoutForecast(…, readiness = true)` in `prepareOrdinaryReadiness`). At epoch 5,
Canvas, the adoption window contains `closed-native-preparation-*`, `closed-recovery-reader-borrowed` and five
`closed-snapshot-preparation-*`. Without the reader, the same capture runs at the epoch's first move
(`ordinary-finishing-source-capture` in the next window). Chat runs two captures at adoption: the source upgrade
and the settlement fence source hint. The work moves to the boundary; the Grid's adoption already does the same.
It is room code shared by every application with a reader, so this track leaves it alone (section 9).

### 5.5 Growth

Track P (hot successors wrap the source's native issuance store) and Canvas's settlement profile (Track T) have
landed. Canvas no longer grows: in Chromium the creator's issuance outbox holds 18 rows from epoch 6 to 8 in both
arms, and the creator's total stored rows are flat from epoch 6 (142 with the reader, 176 at base). Chat is flat
the same way (155 against 194). On the Node host the creator's issuance outbox holds 10, 18, 18 and 18 rows at
epochs 4, 8, 12 and 16 in every run of both applications, and the creator's total rows are flat from epoch 8
(receive-only recipient: 143 shipped against 177 absent; Writer: 156 against 195). Before Tracks P and T, Canvas's
outbox grew by 3 rows per epoch (13, 25, 37, 49) in both arms.

## 6. Grid unchanged

- **By construction.** No Grid file changed, and the Grid composition keeps its own reader. The
  `r8-source-binding` bundle built at this branch and built with the three product files at 19caa468 have the
  same sha256 f0afa06d…77ceec7 (<evidence>/track-q/grid/qbuild-2.log, qbuild-base-2.log). Its 624 inputs include
  neither packages/node/src/applications/canvas.ts nor anything under examples/chat or examples/canvas.
- **Run.** One 8-rollover run with LULL=1 on the default path, using the docs/realtime-latency/README.md recipe
  through <evidence>/track-q/bin/grid.sh (run <evidence>/track-q/grid/run-lull8-2/, summaries
  run-lull8-2-summary.txt and run-lull8-2-grid-summary.txt), load 23–35. 1 passed. The creator lull answers
  `deferred:unsupported` at epochs 1–2 (floor), `not-needed` at 3 and `maintained` at 4–8, the shipped Grid
  pattern; every recipient lull is `maintained` from epoch 3. Medians over transitions t0–t7 (creator lull
  t4–t8): seal 330 ms [149–364], creator adoption 528 [336–712], recipient install 404 [276–519], creator lull
  2701 [2549–2925], creator issue p50 81.6, remote accept p50 53.0. The bundle is byte-identical to base's, so a
  base run would measure the same code; the earlier run on c67c66b7 (seal 362, adoption 592, lull 3416) predates
  Tracks P and M2 and ran at load 50–65.

## 7. Suites against base 19caa468

Method: <evidence>/track-q/bin/suite.sh and swap.sh. Base = the three product files written at 19caa468 in the
same worktree (the only files outside tests/ and docs/ that differ). Every set ran with `SHIPPING_CHAT_CATALOG_DIR`
set to the embedded shipping catalog, materialised by Track M's catalog.py. Per-test comparison:
<evidence>/track-n/bin/vcompare.py, output in <evidence>/track-q/tests/compare2-\*.txt; reports in
<evidence>/track-q/tests/{b2,h2}-\*.json. Head ran first, then base; load 14–108.

| Set                                                                                          | Base pass/fail/skip | Head pass/fail/skip | Per test                                                |
| -------------------------------------------------------------------------------------------- | ------------------- | ------------------- | ------------------------------------------------------- |
| Six Canvas/Chat native tests                                                                 | 35/15/0             | 35/15/0             | identical (the 15 failures predate this track)          |
| storage-node retirement (6 files)                                                            | 158/49/2            | 158/49/2            | identical                                               |
| packages/node                                                                                | 1023/48/0           | 1023/48/0           | identical                                               |
| Root: 117 files (Track N's 93, 7 Canvas/Chat files incl. this track's 3, 17 new on 19caa468) | 823/332/112         | 838/317/112         | 0 new failures; 15 fixed, all this track's RED (13 + 2) |

The 17 root files new on 19caa468 are Track P's canvas-long-room-issuance-retention-native, Track M's
track-m-room-retention-{bounds,differential,long-room,settlement,trust}, track-m-{canvas,chat}-long-room and
track-m-apps-creator-issue-profile, Track M2's track-m2-ledger-{apps,differential,red,split}, Track O's
track-o-room-retention-{resume,split,split-recipient} and Track S's track-s-first-lull-reopen-native. At head:

- K, L, N and R3: recipient-long-room-journal-retention-native 2/2, recipient-lull-reopen-close-native 3/3,
  recipient-long-room-issuance-retention-native 2/2, room-database-retirement-native 4/4 (including
  "(4 rollovers)", which failed in this track's first version);
- P 2/2 (1 measurement test skipped); S 6/6; M's room-retention tests 34/34; M2's 25/25 (measurement tests
  skipped); O's 43/43 (60 cases skipped by their own gates);
- Track M's and M2's application long rooms are measurement tests (`TRACK_M_APPS=1`), skipped in the suite. Their
  "product" mode now picks up this track's reader, so they were run separately (`TRACK_M_APPS=1`):
  - 6 epochs, head and base (<evidence>/track-q/logs/trackm-apps-head-1.log, trackm-apps-base-1.log): identical
    outcomes. Canvas passes on the node, room and room-retention hosts. Chat passes on the node host and fails on
    the room and room-retention hosts at epoch 3's seal on both trees ("creator recovery role transfer source
    failed: internal-invariant"), so that failure predates this track. It is in Track M's harness: this track's
    own harness runs Chat with a Writer recipient on the room host through 8 epochs in Chromium and 6 on
    fake-indexeddb. M2's ledger-apps test fails at 6 epochs on both trees only because its thresholds (at least 4
    compared boundaries, 8 applied decisions) assume its default 16 epochs;
  - M2's ledger-apps test at its default 16 epochs, head: 2/2 pass
    (<evidence>/track-q/logs/trackm2-apps-head-16.log).
- the three root files that fail to load (protected-recovery-role-node-red, r11-real-game-terminal-native,
  r9-rpc-v3-room-native) fail identically on both trees.

Typecheck: `pnpm -r typecheck` exit 0 with 0 errors (<evidence>/track-q/logs/typecheck-rebase-1.log). The
shadowed-source guard (`node scripts/check-shadowed-sources.mjs`) exits 0. Prettier is clean on every new or
changed file.

## 8. History: the reopen-after-first-lull blocker (fixed by Track S)

The first version of this track (on c67c66b7) was held because R3's tests/room-database-retirement-native.test.ts
"(4 rollovers)" passed on base and failed with this change: `creator snapshot role reconciliation refused:
floor-stale`. Supplying the reader made Canvas run a creator lull for the first time, and a persisted reopen right
after the creator's first maintained lull hit a pre-existing, application-independent bug (the unchanged Grid
reproduced it; Track G had recorded the symptom). Track S fixed it in 19caa468: `classifyClosedSigningSummaries`
no longer replays a terminal SAME-P signing summary. At this branch R3's four tests pass, Track S's six tests
pass, and the Canvas and Chat long rooms reopen after epoch 4 on the Node and room hosts (section 5.3).

## 9. What remains, and risks

- **Owner review of both bounds** (section "Bounds for owner review"). Required before any configuration
  consumes the value.
- **Adoption cost** (sections 5.1 and 5.4): +190 to +255 ms per adoption in Chromium, +118 to +482 ms on the
  Node host. This is the existing readiness capture moved from the first move to the boundary. Avoiding it when nothing consumes prepared
  readiness would be a room change (`prepareOrdinaryReadiness`, shared with the Grid) and is not made here.
- **Post-reopen seal** (section 5.3): one inline retirement selection on the first seal after a persisted reopen,
  because the early-turnover token is in memory. Pre-existing room behaviour that also applies to the Grid.
- **Lull length:** about 1.9–2.0 s in Chromium. Moves arriving during it wait. Track M / M2's retention path is
  the work that shortens the lull for every application.
- **Option B, `createIncrementalProjection`:** not supplied. It would move every Canvas and Chat ordinary move onto
  the prepared finishing path, which would call the reader by value. That needs its own per-move evidence, review
  of both bounds, and probably a tighter Chat footprint.
  Taken in track 44 (decision row 79), with the bounds unchanged and Chat's projection gated on its admission policy.
- **Chat bound depends on the admission policy:** stated in the reader. A host that composes the shipping Chat
  without `createShippingChatCapacityAdmissionPolicy` already breaks Chat's own invariant.
- **examples/v3-chat:** no ceiling; it would need a Grid-like material theorem. Track V is moving that demo to
  settlement; it is not touched here.
- **Pre-existing, not this track's:** Track M's Chat long room (`TRACK_M_APPS=1`) fails on the room and
  room-retention hosts at epoch 3's seal (`creator recovery role transfer source failed: internal-invariant`) at
  base 19caa468 and at this branch alike (section 7). Worth a look by Track M or V's owners.
- **Harness:** the Node host's synchronous SQLite starves timers during a lull. Any future lull-ingress test must
  trigger from inside the lull, as `lullWithIngress` does.

## Files and functions touched

Product:

- packages/node/src/applications/canvas.ts: `createV3CanvasApplication`; new `resourceDataRecord`,
  `resourceBoundBases`, `RESOURCE_IDENTITY_KEYS`, `RESOURCE_CARRIER_KEYS`, `RESOURCE_MATERIAL_KEYS`.
- examples/chat/src/v3-chat-application.ts: `createShippingV3ChatApplication`; the same new helpers.
- examples/chat/src/v3-chat-capacity.ts: new export `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`.

Tests, all new:

- tests/canvas-chat-resource-bound.test.ts;
- tests/canvas-chat-creator-lull-native.test.ts;
- tests/canvas-chat-long-room.test.ts;
- tests/fixtures/canvas-chat-lull/: long-room-core.ts, long-room-driver.ts, node-long-room.ts, and browser/
  (build.ts, entry.ts, global-setup.ts, long-room.pw.ts, playwright.config.ts).

No existing test, registry, vector or frozen artifact was edited. docs/realtime-latency/README.md, examples/grid,
examples/v3-chat, examples/canvas and tests/fixtures/startup-discovery are not edited.

## Commits

| Commit   | Change                                                                                    |
| -------- | ----------------------------------------------------------------------------------------- |
| ff22665c | test(track-q): RED for the Canvas and Chat creator lull                                   |
| 17eb3afa | feat(track-q): Canvas and Chat supply their ordinary resource bound                       |
| 494a1454 | test(track-q): deliver lull-time moves inside the creator lull; browser harness           |
| 08e416e6 | test(track-q): record every proof-event kind per long-room window                         |
| fafa66c4 | docs(track-q): record the Canvas and Chat creator lull result (first version)             |
| 74801275 | test(track-q): Canvas long rooms use the shipped settlement profile; reopen on every host |
| f4919f12 | test(track-q): browser long room can alternate prebuilt bundles                           |
| (next)   | docs(track-q): RESULT.md for the rebased branch (this file)                               |

Reproduce:

```sh
# Unit and native RED/GREEN
node_modules/.bin/vitest run tests/canvas-chat-resource-bound.test.ts tests/canvas-chat-creator-lull-native.test.ts \
  --exclude ".claude/**" --no-coverage
# Node long room, 16 epochs, ABBA pairs, persisted reopen after 8
CANVAS_CHAT_LULL=1 CANVAS_CHAT_LULL_REPEAT=2 CANVAS_CHAT_LULL_REOPEN_AFTER=8 CANVAS_CHAT_LULL_OUT=<dir> \
  node_modules/.bin/vitest run tests/canvas-chat-long-room.test.ts --exclude ".claude/**" --no-coverage
# Reopen right after the first lull, node and room hosts
CANVAS_CHAT_LULL=1 CANVAS_CHAT_LULL_EPOCHS=6 CANVAS_CHAT_LULL_REOPEN_AFTER=4 CANVAS_CHAT_LULL_HOSTS=node,room \
  node_modules/.bin/vitest run tests/canvas-chat-long-room.test.ts --exclude ".claude/**" --no-coverage
# Chromium, room path, 8 rollovers, one arm per invocation over a prebuilt bundle
pnpm exec tsx tests/fixtures/canvas-chat-lull/browser/build.ts <bundle dir>
CANVAS_CHAT_LULL_PREBUILT_ASSETS=<bundle dir> CANVAS_CHAT_LULL_BOUNDS=shipped CANVAS_CHAT_LULL_REPEAT=1 \
  CANVAS_CHAT_LULL_REPEAT_FROM=<r> CANVAS_CHAT_LULL_EPOCHS=8 CANVAS_CHAT_LULL_OUT=<dir> \
  pnpm exec playwright test --config tests/fixtures/canvas-chat-lull/browser/playwright.config.ts
```
