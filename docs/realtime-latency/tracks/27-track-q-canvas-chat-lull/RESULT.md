# Track Q: Canvas and Chat creator lull

Worktree: <worktree agent-afc8a0b30ff709f24>/
Branch: worktree-agent-afc8a0b30ff709f24 (base c67c66b7, codex/phase3a1b-p6-golden-path; the brief named 5c6b949d, and
the branch moved by one docs-only commit before the switch, so the product code is identical).
Commits: see "Commits" at the end. Evidence: <evidence>/track-q/ (PROGRESS.md, BOUND.md, logs/, data/, browser/,
grid/, tests/, bin/).

`CC` = packages/node/src/creator-close.ts. `CCRD` = packages/node/src/internal/creator-closed-rollback-data.ts.

## Summary

**Do not merge yet: one existing test regresses (section 7.1).**

- tests/room-database-retirement-native.test.ts "(4 rollovers)" (Track R3) passes on base and fails at this
  branch with `creator snapshot role reconciliation refused: floor-stale`.
- The cause is a pre-existing, application-independent room bug: a persisted reopen right after the creator's
  _first_ maintained lull. The unchanged Grid composition reproduces it, and Track G recorded it.
- Before this change, Canvas never ran the creator lull, so that test could not reach the bug.
- Fixing it is room retirement-resume code, outside this track's scope (application bounds and their wiring).
  The rules forbid editing that test.

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
- **Result, Node SQLite, 16 epochs, 2 ABBA pairs per case, persisted reopen after epoch 8:**
  - the creator lull runs at every epoch from 4 to 16;
  - seal p50 is 170–307 ms against 1548–3987 ms without the reader (0.07–0.14×), with 0 retirement selections
    against 44;
  - moves that arrive while the lull runs are queued and all admitted after it, in delivery order (G23);
  - play continues after the reopen.
- **Result, Chromium, real IndexedDB, room path, 8 rollovers, 3 ABBA pairs:** seal 268–322 ms against
  2639–3260 ms (0.09–0.12×). The longest main-thread task per epoch halves: p50 Canvas 52–54 ms against
  89–104 ms, Chat 136–156 ms against 297–368 ms.
- **Cost:** adoption is slower. Node: Canvas 233–532 ms against 78–116 ms; Chat 567–998 ms against 263–670 ms.
  Chromium: about 2× for both. The adoption boundary now runs the cold ordinary-source capture that the epoch's
  first move ran before (section 5.4), as the Grid's adoption already does. Seal plus adoption, the rollover's
  critical path, is still 2.3–5.1× shorter in every pair.
- **Grid:** unchanged. Its bundle is byte-identical to base (same sha256), and an 8-rollover LULL=1 run passes
  (section 6).
- **Not changed:** Canvas issuance growth (Track P) shows equally with and without the reader. The creator's
  outbox holds 13, 25, 37 and 49 rows at epochs 4, 8, 12 and 16.

## 1. What the bound must express (BOUND.md)

Full text: <evidence>/track-q/BOUND.md. In brief:

**Contract.** `V3RoomApplication.readOrdinaryApplicationResourceBound` (packages/node/src/v3-room.ts:451-453) is an
optional, pure, artifact-bound local planning bound. It is not shared validity or admission. Its type is
`CreatorOrdinaryApplicationResourceBoundReader` (packages/node/src/internal/runtime-reclamation.ts:195-257).
`v3-room.ts:4149-4150` passes it to the creator only.

**It bounds** the canonical footprint {byteLength, items, maxDepth} of any application state the complete
material can produce. That covers any authenticated base, after any of the current, protected and recovery
operations and the candidate. It is an upper bound: the planner may only over-reserve.

**Consumers.**

- _By presence_, without calling it:
  - the lull gate (CC:4808-4810);
  - the explicit readiness boundary (CC:4669-4790);
  - the optional ordinary-source capture and refresh (CC:2459-2546);
  - the ordinary issue path's incremental quote attempt (CC:3486-3512).
- _By value_: `deriveCreatorOrdinaryApplicationResourceForSizing` (CCRD:4840-4936).
  - It accepts only byteLength ≤ maxSnapshotBytes, items ≤ 16384 and depth ≤ 16, and re-decodes every base state
    under the value.
  - It runs only once readiness is _prepared_, which needs `createIncrementalProjection` (CCRD:4318-4332,
    5740-5790). Neither composition supplies one, so the shipped flows never call the reader. Its value must
    still be sound for any configuration that does.

**Failure modes.**

- Too large: the planner misses and the exact path runs. This only costs speed.
- Too small: it under-reserves, which breaks G21 and G22.

So the one requirement is domination.

**The Grid's value** (examples/grid/src/v3-zone.ts:1386-1440, `placementGrowthProjection` in zone-state.js)
depends on the material, because zone state has no ceiling of its own. It is reviewed by
tests/phase-3g-chat-zone-rebase-red.test.ts ("Grid placement-only resource growth", "… catalog binding") and
packages/node/tests/creator-ordinary-neutral-resource.test.ts, and by R8's receipt
(specs/bounded-storage-lifecycle/requirements-to-evidence.md:692-720, 820-828).

**The rule** (G21, G27). An application's bound is a canonical footprint that dominates every state the
application's own capture accepts, computed only from limits that capture enforces. The Grid's capture enforces no
ceiling, so its theorem counts the material. The Canvas and Chat captures each enforce a fixed ceiling, so their
theorem is that ceiling. No product-wide constant is introduced.

| Application                                | Limits used (pre-existing, reviewed)                                                                                                                                          | Bound                                                                                                                                                                                                                         | Status                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Canvas (`createV3CanvasApplication(w, h)`) | `CANVAS_LIMITS` (dimensions 1–64, ≤ 4096 px, counters ≤ `Number.MAX_SAFE_INTEGER`), `CANVAS_SNAPSHOT_LIMITS` (the descriptor's codec law)                                     | exact canonical footprint of `{version:1, width, height, counters: w·h × [MAX_SAFE_INTEGER ×3]}` via the codec's resource algebra: 1×1 73/25/3, 2×2 160/49/3, **10×10 2944/817/3**, 64×32 59438/16401/3, 64×64 118831/32785/3 | Inputs reviewed; the widest-instance derivation is new and reviewed only by its tests                                                                  |
| Chat (`createShippingV3ChatApplication`)   | `captureShippingChatCapacityState` `LIMITS` = {maxBytes 32768 (`SHIPPING_CHAT_RETAINED_BYTES`), maxItems 16384, maxDepth 16}; plan "the existing 32 KiB state bound", R2E:904 | **{32768, 16384, 16}**                                                                                                                                                                                                        | The value is the existing limits verbatim; the claim that every Chat state passes that capture holds for the composition with its own admission policy |

Above 2045 pixels the Canvas item count exceeds the generic 16384 envelope. The consumer then refuses the value and
the exact path runs, which only costs speed. Such a state cannot fit the generic state machine anyway.

**Why Chat's bound depends on the admission policy.** The compiled Chat reducer checks shape, not the 32 KiB
ceiling. `createShippingChatCapacityAdmissionPolicy` captures the complete joined state of every reservation, and
the shipped composition installs it (examples/chat/src/index.ts:291), as do the R9 fixtures and this track's
harness. The reader's doc comment states this dependency.

**Review status.** Neither bound changes a limit, an admission rule, a retirement decision or a proof charge. Both
need the slice or track owner's review before any configuration consumes the value. That would be a prepared path
with `createIncrementalProjection`, which this track does not add (section 8).

**examples/v3-chat** (the demo Chat) is not changed. Its state is an unbounded message list with no application
ceiling. It would need a material-dependent theorem like the Grid's. Its source text is also read by contract
tests.

## 2. The change

Commit 0bc1aae5.

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
derivation (G21) and the statement that the value grants no validity, admission, authority or credit.

## 3. Tests

### 3.1 RED (committed first, 9c0cffaa)

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
- Fixtures: tests/fixtures/canvas-chat-lull/. Adapted from Track M's da3704ac harness without its retention host:
  only the default host, the browser host and the room host.

On base: unit 13/13 fail (<evidence>/track-q/logs/red-unit-1.log). Native 2/2 fail
(<evidence>/track-q/logs/red-native-1.log): every lull is `deferred:unsupported`, and the seals of epochs 5
and 6 run 4 retirement selections each (Canvas 1916 and 3734 ms, Chat 2088 and 4722 ms).

### 3.2 GREEN

- Unit 13/13 (<evidence>/track-q/logs/green-unit-1.log).
- Native 2/2 (<evidence>/track-q/logs/green-native-1.log). Both pass again at HEAD in the root suite (section 7).

### 3.3 Long-room evidence test

tests/canvas-chat-long-room.test.ts runs only with `CANVAS_CHAT_LULL=1`. It covers:

- Canvas and Chat;
- the node, room and browser hosts;
- receive-only and Writer recipients;
- `shipped` against `absent` (the same composition with only the reader removed: the base shape, so one tree
  yields interleaved pairs);
- optional persisted reopen.

Per epoch it asserts:

- G23: every row delivered during the lull, and the creator's own move, was admitted, and delivered rows were
  admitted in order;
- a lull that selected retirement had the moves handed to it while still running;
- `absent` is always `deferred:unsupported`;
- `shipped` is never deferred from epoch 3;
- no seal after a maintained lull runs retirement, except the first seal after a reopen, which is reported
  (section 5.3).

The browser twin is tests/fixtures/canvas-chat-lull/browser/long-room.pw.ts.

**Harness correction (ef13154a).** The first shakeout (<evidence>/track-q/logs/shake-1.log) showed that a
timer-based delivery never reached the lull on the Node SQLite host. The lull is synchronous `DatabaseSync` work,
so the timer fired only after it settled. Every epoch reported `pendingAtDelivery` false, and G23 was not
exercised.

The endpoint's `lullWithIngress` now works as follows:

1. It subscribes to the role's own proof events.
2. It starts `maintainRecoveryPool()`.
3. When the lull's own `closed-retirement-selection` fires, its boundary has entered and ingress is frozen. It
   then hands the peer's signed rows to the room's ordinary ingress synchronously and issues one local move.

Chat's Writer recipient publishes the settlement author fence (`$drp.author-fence.v1`) before its moves. The
creator admits that control without an `onAcceptedVertex` notification, so it counts as admitted when a reported
delivered row depends on it.

## 4. Guarantees

- **G21 (bounded work, reviewed limits):**
  - Both values come from limits the applications' captures already enforce (`CANVAS_LIMITS` and the snapshot
    codec law; Chat's 32 KiB `LIMITS`). None comes from a measurement.
  - The lull is the existing bounded lull. The creator's own comment says it runs "the SAME original
    reconciliation at a quiescent lull" with "the close's inline maintenance … as the hard-cap backstop"
    (CC:4800-4802), and neither is changed.
  - Where the value is consumed, the consumer still enforces the generic envelope and re-decodes every base.
- **G22 (proof budget and charges):**
  - No charge, budget or reservation changed.
  - The readers grant nothing. Domination, the only property a consumer relies on, is tested: equality with the
    widest real state, domination of reachable states, and Chat's capture ceiling.
  - Same retirement in a different window: 4 retirement selections per epoch in both arms. Each 16-epoch run:
    - without the reader: 48 at seal (epochs 5–16);
    - with the reader: 52 in lulls (epochs 4–16) plus 1 at the post-reopen seal. The lull starts one epoch
      earlier, at epoch 4's quiescent point instead of epoch 5's seal.
- **G23 (ingress during a deferrable lull queues FIFO, nothing dropped, provenance rechecked):**
  - In every epoch whose lull selected retirement, the moves were delivered while the lull ran: entered and
    pending in 13 of 13 epochs per Node run and 5 of 5 per browser run. Every delivered row and the creator's
    own move were admitted. Delivered rows were admitted in delivery order. Both settled after the lull.
  - Rows enter through the room's ordinary authenticated ingress (`setIngressHandler`), so provenance is
    rechecked at admission by the unchanged path.
  - Absent runs, where the lull answers at once, show the same admission.
- **G26 (no trade for speed):**
  - No check was removed and no limit loosened. The retirement decision is the same work, moved to the lull.
  - Stored rows: after each lull, shipped holds fewer rows than absent, because retirement already ran. Absent
    retires one epoch later, at the next seal. The only cells where shipped holds more are 4 retirement-control
    rows at epoch 4, created one epoch earlier.
  - Both arms reach the same flat creator stores, except Canvas issuance (Track P), which grows identically in
    both.
- **G27 (no game-specific carve-outs):**
  - One rule, stated in each reader and in BOUND.md, applied to each application's own reviewed limits.
  - Canvas and Chat use the same optional application field the Grid uses. The room, the lull and the consumers
    have no application-specific branch, and no product-wide constant was added.

## 5. Canvas and Chat: before and after

### 5.1 Node SQLite, 16 epochs

Data:

- run: <evidence>/track-q/data/node-pairs-1/ (log <evidence>/track-q/logs/node-pairs-1.log);
- tables: <evidence>/track-q/data/node-pairs-1.txt (bin/pairs.py) and node-pairs-1-census.txt
  (bin/census.py).

Setup:

- 2 moves per Writer per epoch, plus 2 Writer-recipient moves and 1 creator move during each creator lull;
- 300 ms settle before seal;
- persisted reopen after epoch 8;
- 2 interleaved ABBA pairs per case, load 53–57;
- 16/16 runs pass.

Medians over epochs 4–16, excluding the first epoch after the reopen. Each cell lists shipped/absent for repeat
0, then repeat 1; times in ms.

| Case                 | Seal               | Seal retirement (Σ) | Adoption         | Install          | Creator lull (shipped only; absent does not run) | Creator issue / move |
| -------------------- | ------------------ | ------------------- | ---------------- | ---------------- | ------------------------------------------------ | -------------------- |
| Canvas, receive-only | 177/1913, 170/1662 | 0/44, 0/44          | 238/89, 233/78   | 84/80, 80/77     | 1749, 1630                                       | 206/266, 199/256     |
| Canvas, Writer       | 288/2736, 206/2549 | 0/44, 0/44          | 532/116, 326/106 | 275/150, 159/166 | 3933, 2134                                       | 191/138, 124/171     |
| Chat, receive-only   | 259/3987, 219/3046 | 0/44, 0/44          | 649/670, 619/386 | 139/151, 116/152 | 2519, 2252                                       | 287/542, 211/401     |
| Chat, Writer         | 211/1548, 307/2674 | 0/44, 0/44          | 567/263, 998/387 | 188/142, 279/226 | 2007, 3253                                       | 117/104, 210/149     |

Results:

- **Lull ran each epoch.** Shipped: `deferred:unsupported` at epochs 1–2 (the lull's own floor, `currentEpoch < 3`,
  CC:4809), `not-needed` at 3, `maintained` at 4–16 with 4 retirement selections each. Absent:
  `deferred:unsupported` at all 16 epochs.
- **Seal no longer includes retirement:** 0.07–0.14× with 0 selections.
- **Critical path.** Seal plus adoption, shipped against absent: Canvas receive-only 415 against 2002 ms and
  403 against 1740 ms; Chat Writer 778 against 1811 ms and 1305 against 3061 ms.
- **Per-move latency** shows no direction. Shipped/absent ratios across all pairs: creator issue 0.52–1.40,
  recipient issue 0.89–1.27, creator admitting a remote move 0.68–1.50, recipient admitting 0.87–1.04.
- **G23.** Every lull-time move was admitted after the lull. Times are p50 per run from delivery, under load
  53–57:

  - with the reader: the creator's own lull move 1613–6854 ms, the last remote row 2875–6811 ms; the
    worst epoch, under a load spike, was 17.0 s;
  - without the reader: 279–2410 ms and 1442–2378 ms (the cost of the epoch's first moves, section 5.4).

  Moves arriving during a lull wait for it, as Track A's design states (v3-room.ts:548-553). How long the lull
  takes is Track M's subject.

### 5.2 Chromium, real IndexedDB, room path, 8 rollovers

Data:

- run: <evidence>/track-q/browser/pairs-1/ (summary pairs-1.txt);
- 12/12 runs pass, load 55–76;
- 3 interleaved ABBA pairs per case;
- two pages on two origins;
- medians over epochs 4–8.

Each cell lists shipped/absent for repeats 0, 1 and 2; times in ms.

| Case                 | Seal                         | Adoption                   | Install                   | Creator lull     | Creator issue / move      | Longest task per epoch, p50 (max)                       |
| -------------------- | ---------------------------- | -------------------------- | ------------------------- | ---------------- | ------------------------- | ------------------------------------------------------- |
| Canvas, receive-only | 283/3260, 305/2639, 322/2714 | 455/224, 501/211, 561/202  | 193/246, 216/208, 224/216 | 2720, 2835, 2781 | 340/437, 326/405, 333/397 | 53/104 (72/138), 54/91 (72/140), 52/89 (66/135)         |
| Chat, Writer         | 268/2844, 278/2842, 277/2791 | 1048/480, 796/509, 752/483 | 362/363, 341/341, 344/326 | 2608, 2704, 2604 | 131/137, 120/146, 120/140 | 153/297 (170/490), 156/368 (157/576), 136/343 (143/555) |

Other measures:

- Creator admitting a remote move: 148/131, 117/137 and 115/132 (Chat).
- Recipient lull: no direction.
- G23: entered and pending in 5 of 5 maintained epochs in every shipped run; all admitted, FIFO.
- Long tasks are read per page per epoch (PerformanceObserver `longtask`). The inline seal retirement produced
  the epoch's longest task, up to 576 ms in Chat. With the lull, the longest is at most 72 ms (Canvas) and 170 ms
  (Chat).

### 5.3 Persisted reopen

- Node host, after epoch 8, both roles closed and reopened from their stores. The state hex and the installed
  authority epoch are equal, and play continued to epoch 16 in every run.
- The first seal after the reopen runs 1 retirement selection (418–1589 ms) against 4 without the reader
  (1508–5578 ms). The lull's early-turnover token (CC:4855) is in memory and does not survive the reopen, so the
  seal discharges that epoch's planned retirement. From the next epoch on, every seal is back to 0.
- Reopen took 866–4819 ms shipped against 361–954 ms absent, one sample per run under load. With a reader, the
  reopened creator's startup runs the same readiness capture as an adoption boundary
  (`prepareCurrentCreatorOrdinaryReadiness`, v3-room.ts:5659-5680, before the session reports ready).

### 5.4 Why adoption is slower

Data: <evidence>/track-q/data/kinds-1/, a 6-epoch run recording every proof-event kind per window, commit
c47400a7.

With the reader present, the adoption boundary runs the cold ordinary-source capture
(`captureCreatorOrdinarySourceWithoutForecast(…, readiness = true)`, CC:4709). At epoch 5, Canvas, the adoption
window contains:

- `closed-native-preparation-*`;
- `closed-recovery-reader-borrowed`;
- five `closed-snapshot-preparation-*`.

Without the reader, the same capture runs instead at the epoch's first move (`ordinary-finishing-source-capture`
in the next window). Chat runs two captures at adoption: the source upgrade and the settlement fence source hint.
The work moves to the boundary; the Grid's adoption already does the same.

It is room code, shared by every application with a reader, so this track leaves it alone (section 8).

### 5.5 Canvas lull cost per epoch, and growth (Track P)

The creator's issuance outbox holds 13, 25, 37 and 49 rows at epochs 4, 8, 12 and 16 in both arms: +3 rows per
epoch, 2 moves plus 1 lull move. From epoch 8 to 16, total creator rows grow by 6 per epoch in both arms
(Canvas receive-only: shipped 162 → 210, absent 198 → 246).

Chat is flat from epoch 8 in both arms: creator 143 rows shipped against 177 absent, outbox 18.

Theil–Sen slopes of the shipped creator lull, epochs 4–16:

- Canvas: receive-only +55 and +83 ms per epoch; Writer −15 and −11 (load noise dominates);
- Chat: −44 to +189.

The absent seal slopes are Canvas +50 to +66 and Chat +15 to +350. The Canvas lull cost per epoch is in
<evidence>/track-q/data/node-pairs-1/\*.jsonl (`latency.creatorLull`). Until Track P lands, Canvas issue and lull
work grows with room age whether or not the reader is present.

## 6. Grid unchanged

- **By construction.** No Grid file changed, and the Grid composition (examples/grid/src/v3-zone.ts) keeps its
  own reader. The `r8-source-binding` bundle built from this branch has sha256 8ac0e629…fc435b
  (<evidence>/track-q/grid/qbuild-1.log). That is the same hash as Track N's final bundle
  (<evidence>/track-n/grid/build-fix2.log), whose code is the base. Its input list includes examples/v3-chat
  (unchanged) and neither changed file: packages/node/src/applications/canvas.ts and examples/chat are not Grid
  inputs.
- **Run.** One 8-rollover run with LULL=1 on the default path, using the README recipe through
  <evidence>/track-q/bin/grid.sh (run <evidence>/track-q/grid/run-lull8-1/, summary run-lull8-1-summary.txt).
  1 passed. The lull answers `deferred:unsupported` at epochs 1–2 (floor), `not-needed` at 3, and `maintained`
  at 4–8, the shipped Grid pattern. Medians over transitions t0–t7 (lull t4–t8), against Track N's run of the
  same bundle (run-long16-head-default-1, first 8 transitions):

  | Phase             | This run         | Track N, same bundle |
  | ----------------- | ---------------- | -------------------- |
  | Seal              | 362 [166–400]    | 319 [177–379]        |
  | Creator adoption  | 592 [341–802]    | 608 [398–865]        |
  | Recipient install | 456 [308–738]    | 401 [314–432]        |
  | Creator lull      | 3416 [2709–3670] | 3121 [2890–3282]     |
  | Creator issue p50 | 96.6             | 96.6                 |
  | Remote accept p50 | 66.1             | 61.5                 |

  Load was 50–65 here. The bundle is identical, so the differences are load.

## 7. Suites against base

Method: <evidence>/track-q/bin/suite.sh and swap.sh. Base = the three product files written at c67c66b7 in the
same worktree. Every set ran with `SHIPPING_CHAT_CATALOG_DIR` set to the embedded shipping catalog, materialised by
Track M's catalog.py. Per-test comparison: <evidence>/track-n/bin/vcompare.py, output in
<evidence>/track-q/tests/compare-_.txt; reports in <evidence>/track-q/tests/{base,head}-_.json. Load was 15–155.

| Set                                                                                                                                                     | Base pass/fail/skip | Head pass/fail/skip | Per test                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------- | ---------------------------------------------------------------------------- |
| Six Canvas/Chat native tests                                                                                                                            | 35/15/0             | 35/15/0             | identical (the 15 failures predate this track and match Track M's §11 table) |
| storage-node retirement (6 files)                                                                                                                       | 158/49/2            | 158/49/2            | identical                                                                    |
| packages/node                                                                                                                                           | 1023/48/0           | 1023/48/0           | identical (2 files fail to load on both)                                     |
| Root (Track N's 93 files + v3-canvas-equivalence, r9-chat-metadata-native, r9-chat-capacity-ledger, r9-chat-artifact-contract and this track's 3 files) | 712/333/37          | 719/326/37          | see below                                                                    |

Root, per test:

- **Fixed at head: 16.**
  - 15 are this track's RED tests: unit 13, native 2.
  - 1 is phase-3-exit-envelope-purity "fresh child-process module load". It failed on base with a `spawnSync`
    error under load; it is load noise.
- **New failures at head: 9.**
  - 8 are tests/d110c-0c1f5b0a-settlement-codec-red.test.ts, each a 120 s timeout in the part of the head run at
    load 155. Rerun alone at head, 8 pass, and the remaining 2 fail on base too
    (<evidence>/track-q/logs/codec-head-1.log).
  - 1 is real: tests/room-database-retirement-native.test.ts "both peers retire inside one room session per
    install and keep playing after a persisted reopen (4 rollovers)". It fails deterministically, again when run
    alone (<evidence>/track-q/logs/rdr-head-1.log), and passes on base. See 7.1.
- The K, L, R3 and N native tests otherwise pass on both trees, including:
  - recipient-long-room-journal-retention-native;
  - recipient-lull-reopen-close-native;
  - recipient-long-room-issuance-retention-native;
  - room-database-retirement-native's 5-rollover and crash-resume cases.

Typecheck: `pnpm -r typecheck` exit 0 with 0 errors (<evidence>/track-q/logs/typecheck-1.log). The shadowed-source
guard (`node scripts/check-shadowed-sources.mjs`) is clean. Prettier is clean on every new file. ESLint reports 0
errors.

### 7.1 The regression: reopen right after the first creator lull (pre-existing floor-stale)

**What fails.** R3's test drives `createV3CanvasApplication(2, 2)` on the browser room-database host
(fake-indexeddb). Every rollover calls `creator.room.maintainRecoveryPool()`.

- On base the Canvas creator lull is always `deferred:unsupported`, so the test never exercised a creator lull.
- At head the lull answers `deferred:unsupported` at epochs 1–2, `not-needed` at 3 and `maintained` at 4, the
  first pool turnover. Both peers are then closed and reopened from their stores. The creator's first seal after
  the reopen throws:
  - `TypeError: creator snapshot role reconciliation refused: floor-stale`, raised from
    `reconcileSnapshotRecoveryRoles` (CCRD:21826);
  - through `installClosedRetirementSourceInRoom` (CCRD:19209);
  - at `installClosedRetirementSource`'s check that a stored signing-summary `resumeBasisDigest` equals the one
    recomputed from the current source (CCRD:19350-19351).
- A probe copy with step logs located it (<evidence>/track-q/logs/rdr-probe-1.log; the copy is in
  <evidence>/track-q/trash/).
- The 5-rollover variant (two maintained lulls before the reopen) passes.

**It is not Canvas-specific, and it predates this track.**

- The unchanged Grid composition fails the same way. A copy of Track N's
  tests/recipient-long-room-issuance-retention-native.test.ts, with the reopen moved to epoch 4 and only its
  epoch-floor and pruning assertions removed, fails with the same refusal right after the creator's first
  maintained lull (<evidence>/track-q/logs/grid-reopen4-1.log; the copy is in <evidence>/track-q/trash/).
- This track's Canvas long room on the Node SQLite host with a reopen after epoch 4 fails at the reopen itself, in
  the startup readiness preparation (<evidence>/track-q/logs/reopen4-node-1.log). The same harness with a reopen
  after epoch 8 passes in all 16 runs.
- Track G recorded the same symptom on the Grid: "a 4-rollover run with the concurrent lull fails at persisted
  reopen with 'creator snapshot role reconciliation refused: floor-stale'"
  (docs/realtime-latency/tracks/16-track-g-presentation-overlay/README.md:154).

**Impact.**

- The refusal fails closed, so no guarantee is weakened: nothing is retired on a stale basis.
- But the room stops. A creator that is closed right after its first lull turnover cannot seal (room host) or
  reopen (Node host).
- This change makes that reachable for Canvas and Chat, for any embedder that calls `maintainRecoveryPool()`. No
  shipped example app calls it; the Grid bench (LULL=1) and the tests do.

**Why this track stops here.** Making R3's 4-rollover test pass needs one of two things:

- a fix in the room's retirement-resume path, which is shared with the Grid and outside "the application
  resource bounds and their wiring";
- an edit to that existing test, which is forbidden.

Withholding the bound from the room host would be a per-path carve-out (G27), and it would only hide the bug.
Recommendation: hold the merge until the reopen-after-first-turnover `floor-stale` is fixed, with this test and
the Grid probe as its RED. The rest of this branch stands as is.

## 8. What remains, and risks

- **Blocking: reopen right after the first creator lull** (section 7.1). This is a pre-existing room bug that
  this change makes reachable for Canvas and Chat, and it fails R3's 4-rollover test. It needs a fix in the
  retirement-resume path (CCRD:19350, the signing-summary `resumeBasisDigest` check) before this branch merges.
- **Adoption cost** (section 5.4): +150 to +420 ms (Node) and about 2× (Chromium) per adoption. This is the
  existing readiness capture moved from the first move to the boundary. Avoiding it when nothing consumes prepared
  readiness would be a room change, `prepareOrdinaryReadiness`, shared with the Grid, and is not made here.
- **Post-reopen seal** (section 5.3): one inline retirement selection on the first seal after a persisted reopen,
  because the early-turnover token is in memory. This is pre-existing room behaviour, which also applies to the
  Grid. Persisting it, or running a lull before the first seal, would remove it.
- **Lull length:** 1.6–3.9 s (Node) and 2.6–2.8 s (Chromium). Moves arriving during it wait. Track M (14b/14e,
  stage 2 in M2) is the work that shortens the lull for every application.
- **Option B, `createIncrementalProjection`:** not supplied. With a material-independent bound it is trivial
  (`advance` true, every quote the same footprint). It would move every Canvas and Chat ordinary move onto the
  prepared finishing path, which would call the reader by value. That needs its own per-move evidence, review of
  both bounds, and probably a tighter Chat footprint (a minimal message suggests about 5000 items, not 16384).
- **Chat bound depends on the admission policy:** stated in the reader. A host that composes the shipping Chat
  without `createShippingChatCapacityAdmissionPolicy` already breaks Chat's own invariant, because its projection
  throws above the ceiling.
- **Canvas growth (Track P):** unaffected and still unbounded until P lands.
- **examples/v3-chat:** the demo has no ceiling; it would need a Grid-like material theorem.
- **Review:** both derivations need the owner's review before any configuration consumes the value (section 1).
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

No existing test, registry, vector or frozen artifact was edited. docs/realtime-latency/README.md is not edited.

## Commits

| Commit   | Change                                                                          |
| -------- | ------------------------------------------------------------------------------- |
| 9c0cffaa | test(track-q): RED for the Canvas and Chat creator lull                         |
| 0bc1aae5 | feat(track-q): Canvas and Chat supply their ordinary resource bound             |
| ef13154a | test(track-q): deliver lull-time moves inside the creator lull; browser harness |
| c47400a7 | test(track-q): record every proof-event kind per long-room window               |
| (next)   | docs(track-q): RESULT.md (this file)                                            |

Reproduce:

```sh
# Unit and native RED/GREEN
node_modules/.bin/vitest run tests/canvas-chat-resource-bound.test.ts tests/canvas-chat-creator-lull-native.test.ts \
  --exclude ".claude/**" --no-coverage
# Node long room, 16 epochs, ABBA pairs, persisted reopen after 8
CANVAS_CHAT_LULL=1 CANVAS_CHAT_LULL_REPEAT=2 CANVAS_CHAT_LULL_REOPEN_AFTER=8 CANVAS_CHAT_LULL_OUT=<dir> \
  node_modules/.bin/vitest run tests/canvas-chat-long-room.test.ts --exclude ".claude/**" --no-coverage
# Chromium, room path, 8 rollovers, 3 ABBA pairs
CANVAS_CHAT_LULL_EPOCHS=8 CANVAS_CHAT_LULL_REPEAT=3 CANVAS_CHAT_LULL_EVIDENCE=<dir> CANVAS_CHAT_LULL_OUT=<dir> \
  pnpm exec playwright test --config tests/fixtures/canvas-chat-lull/browser/playwright.config.ts
# The regression (section 7.1)
node_modules/.bin/vitest run tests/room-database-retirement-native.test.ts -t "4 rollovers" \
  --exclude ".claude/**" --no-coverage
```
