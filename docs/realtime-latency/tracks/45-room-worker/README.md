# Track 45: apps can host their room in a background worker (opt-in)

Branch `feat/room-worker` (from 22a7b582, plus the FPS harness commits 076f8858..5691794c).
Not merged: it merges after the integration-7 regression bisect.

## Problem

The user's decision: "we should offer apps to run off the main thread on a background worker."

On the main thread, a real-time game page shares one thread with the whole room: the node, libp2p,
the v3 room's admission, codec, signing and IndexedDB work. The Grid worker spike measured main-thread
busy time per frame at p99 27–56 ms with the room on the main thread, and 4.3–4.9 ms with it in a worker.
Profile M allows 2 ms. The spike was Grid-only, and it was not a library feature.

## Change

An opt-in library feature. The current main-thread API is unchanged, and apps that do not opt in run as
before.

- **`@ts-drp/room-worker`** (new package, generic).
  - Thread split:
    - The worker owns the node, the room, its stores, the codec and signing.
    - The page keeps rendering, input, identity (the Web Lock and seed) and the real
      `RTCPeerConnection`s.
    - Workers have no `RTCPeerConnection`, so the page creates each data channel and transfers it into
      the worker. The worker installs its RTC stand-ins before the app's network modules are evaluated,
      because they capture the globals then. That is why the app module is loaded lazily.
  - A closed command contract, shared by both sides:
    - `call` returns a promise. Its result is posted after every stream value the command emitted, so
      the page reads its own writes.
    - `send` is fire-and-forget, with a synchronous validator on the page. Its refusals carry the
      send's correlation id (condition B).
    - `latest` streams send at most one value per stream per page frame.
    - Page hooks return page-owned handles whose methods are allowlisted.
  - Every message carries a session; a stale session's messages are dropped (G4).
  - Typed errors cross by codec, so `instanceof` still works on the page.
  - Package errors: `RoomWorkerUnsupported`, `RoomWorkerCrashed`, `RoomWorkerClosed`, `RoomWorkerLimit`
    and `RoomWorkerProtocolError`.
  - `openRoomWorker` throws `RoomWorkerUnsupported` when the browser cannot host the room in a worker,
    and the app then opens the room on the main thread. There is no relay mode.
  - The rules are in `packages/room-worker/README.md`.
- **packages/node.** The browser-local peer cache takes an optional `storage` (default localStorage,
  unchanged), so the worker can mirror the page's localStorage key.
- **examples/v3-room.**
  - Codecs for every `V3Room*` refusal and for `DRPError`.
  - The worker node config.
  - A light rollover-observation stand-in for the harness.
  - It also exports `V3RoomAwaitingFence`; the new completeness test found it missing.
- **Grid, the first adopter (`?roomWorker`).**
  - `zone-worker.ts`, `zone-worker-app.ts`, `zone-worker-contract.ts` and `zone-worker-page.ts`.
  - `index.ts` dispatches to `main-thread.ts`, the unchanged default and the fallback.
  - `snapshot()` is the last published zone, `refresh()` asks for the current one, and moves are
    `send`.
  - `recoverBlockPlacement` applies the crash-ambiguity rule.
  - `?roomWorkerMeter` turns on the bridge meter.

## Crash ambiguity (condition A)

When the worker dies, calls in flight reject with `RoomWorkerCrashed`, but the room may already have
durably admitted the work. The rule:

1. Reopen and rejoin.
2. Look for the operation's identity in the durable projection. For Grid, that is the block id.
3. If it is present, the operation landed and must not be offered again.
4. If it is absent, offer it once.

A re-offer the room refuses but keeps (`V3RoomReadOnly`, `V3RoomSuccessorUnavailable`,
`V3RoomNotReachingHost`: a member that does not yet reach its creator) is offered by the room itself at
the next epoch, so the app must not offer it again.

`tests/room-worker-grid.pw.ts` covers both sides:

- It terminates the member's worker inside the projection message that first shows the block, before the
  call's reply is handled. The call rejects with `RoomWorkerCrashed`; after reopen the recovery finds the
  block ("landed"). Both replicas then hold it once at durable vertex count +1, and the next placement
  makes it +2.
- The control terminates the worker in the same page task that posts the call, so the worker never runs
  it. The recovery offers it again, it lands once, and the count stays +1 five seconds later.

## Evidence

All runs are on boat sandbox bx_e28t8ews (8 vCPU x86_64).

### Suites

- `tests/room-worker-grid.pw.ts`, grid-5b: 6/6. That covers condition A and its control, the fallback, and
  the smoke test on Chromium, Firefox and WebKit.
- d9346 v3-zone in worker mode (both, creator, joiner): passes to the migration-target rejoin (line 899).
  Main-thread head and base fail at the same known load-dependent step. It is the same on 026e9cb6,
  where the session snapshot became a call.
- 026e9cb6: grid-6 passes 6/6. 2984d84f (Grid contract v2): grid-7 passes 6/6.
- Packages vitest: 22 of 403 files fail. 16 fail identically at base; the other 6 pass when rerun alone in
  three alternating head/base passes.
- The package's own tests: 38/38, including `stop-order.test.ts`.

### Frame cost (condition E)

Grid FPS harness, 10 epochs, paired main/worker runs, without tracing.

- Library = the bridge's main-thread work per page frame: worker message handling less the Grid
  rendering it ran, plus posts.
- Render = Grid's DOM rendering.
- Frame p99 is the interval between page frames.

ab3 (85717dff) found the library p99 at 2.3–3.2 ms (throttle 1) and 10.6–13.4 ms (throttle 4). The
per-kind meter (a25cd8bd) put about 90% of the frames over 0.5 ms on one message kind: the network
panel stream. That stream carried the modular session's diagnostics, whose control-plane event log grew
for the whole session, so every change re-sent the whole log to the page.

- 026e9cb6 streams the panel only and makes the diagnostics a call.
- a9a7684b caps the log at the source, for both modes: 256 events, plus a dropped count.

ab4 (026e9cb6), two pairs per throttle:

| Throttle | Mode | Library p50 / p99 (ms) | Render p99 (ms) | Frame p99 (ms) | Frames > 50 ms | Long tasks (count / ms) |
|---|---|---|---|---|---|---|
| 1 | main | n/a (whole room on the main thread) | n/a | 21–29 | 0–20 | 0–5 / 0–743 |
| 1 | worker | 0–0.1 / 0.5–0.8 | 0.5–0.6 | 19–20 | 0–4 | 0 |
| 4 | main | n/a | n/a | 38–45 | 107–159 | 71–125 / 5.1–10.7 s |
| 4 | worker | 0–0.1 / 1.4–2.9 | 1.7–2.0 | 22–26 | 0–26 | 0–16 / 0–1.7 s |

- **Paired frame p99, worker minus main**, creator and member:
  - throttle 1: −9 and −7 (pair 1), −2 and −2 (pair 2);
  - throttle 4: −21 and −14, −17 and −19.
- **Throttle 1: what remains** of the library cost (frames over 0.5 ms are 1–2% of frames):
  - creating data channels on the page, about 0.2 ms each, at 4–9 opens/s;
  - the host-calls of the page-owned room-head authority, about 75 per second at 0.01–0.03 ms each. That
    is the harness's stand-in for an app host's native store.
  - Library plus render p99 is 0.7–0.9 ms, inside Profile M's 2 ms.
- **Condition E's 0.5 ms library p99**: the creator meets it (0.5 ms). The member is just above it (0.6–0.8 ms),
  and that is accepted for now. What puts the member's frames over 0.5 ms (throttle 1, 171 such frames
  in about 6,560):

  | Message kind | Frames over 0.5 ms it is in | Its ms in them | Mean per message |
  |---|---|---|---|
  | `rtc:createDataChannel` (page) | 89 | 108 | 0.59 ms (max 8.6) |
  | `post:host-result` (authority) | 86 | 24 | 0.024 ms |
  | `post:send:move` | 34 | 18 | 0.035 ms |
  | `stream:transient` | 55 | 18 | 0.045 ms |
  | `post:credit:transient` | 61 | 14 | 0.025 ms |
  | authority host-calls (`readRetirementImage`, `check`, ...) | 47 or fewer | 2.5 or less | 0.023 ms |

  Data-channel creation dominates. The network node opens a new libp2p stream per message (direct
  messages, v3 vertex egress, sync), and over WebRTC each stream is one `RTCDataChannel`, which only the
  page can create. That costs main-thread time in both modes, at 4–9 opens/s per page. Batching the
  authority's host-calls would not reach 0.5 ms. Stream reuse is the network track's work, not this
  branch's.

Main-thread busy time per frame, traced (creator epochs 3–5, one run per cell, both pages, `trace.py`).
This is the same method in both modes. It counts every top-level main-thread task: the library, Grid,
the harness probes, the meter, the browser's own tasks and tracing overhead.

| Throttle | Main p50 / p99 (ms) | Worker before 026e9cb6 p50 / p99 | Worker on 026e9cb6 p50 / p99 |
|---|---|---|---|
| 1 | 12.1–12.3 / 18.1–22.6 | 1.2–1.3 / 5.6–9.3 | 1.0–1.2 / 3.6–4.4 |
| 4 | 13.1–13.2 / 49.3–54.0 | 3.7–4.6 / 11.9–16.8 | 3.5–4.0 / 12.0–16.7 |

At throttle 1, the gap between the traced worker p99 (3.6–4.4 ms) and the untraced library plus render p99
(0.7–0.9 ms) is the harness, the meter, the browser's tasks and tracing.

### Movement latency and join

| Throttle | Mode | Input to remote render p50 / p95 / p99 (ms) | Open (ms) |
|---|---|---|---|
| 1 | main | 18–22 / 34–35 / 40–57 | 4,885–11,139 |
| 1 | worker | 16–37 / 49–50 / 52–110 | 5,784–6,110 |
| 4 | main | 17–23 / 36–55 / 50–490 | 6,053–6,509 |
| 4 | worker | 23–38 / 49–53 / 60–140 | 5,843–6,747 |

- In ab4, worker mode added about 15 ms at p95 to movement. The bridge latency meter (6a286b2c) split the
  path from the worker emitting a remote move to the page rendering it (lat2, throttle 1):

  | Stage | p50 | p95 | p99 |
  |---|---|---|---|
  | Transient value waiting for the page's frame credit | 0 | 25–29 ms | 31–34 ms |
  | Worker to page hop | 1.2 ms | 15 ms | 17–19 ms |
  | Page handling to its render frame (main mode has it too) | 15.7 ms | 18 ms | 20 ms |
  | Sender's page to worker move hop | 0.1–0.2 ms | 2–4.6 ms | 7–29 ms |

  The credit was the cause. Credit came back only at the page's next frame, plus a round trip.
  2984d84f adds `latest({ pace: "message" })`: the page asks for the next value as soon as it has handled
  one, and one value stays in flight. Grid's transient stream uses it. After the change (lat3):

  - the credit wait is p95 9.5–11.8 ms, p99 14–15 ms;
  - the hop tail is unchanged and frame-aligned. Main mode's data-channel message meets the same
    main-thread task queue, so it is not a worker cost.

  ab5 (2984d84f, two pairs per throttle), input to remote render:

  | Throttle | Mode | p50 (ms) | p95 (ms) | p99 (ms) |
  |---|---|---|---|---|
  | 1 | main | 14–17 | 32–35 | 34–62 |
  | 1 | worker | 18–19 | 33–35 | 35–70 |
  | 4 | main | 16–22 | 36–45 | 56–110 |
  | 4 | worker | 19–22 | 33–38 | 40–55 |

  - Throttle 1, paired p95 (worker minus main): −1 and 0 (pair 1), −1 and +3 (pair 2). The p50 is about
    +2 ms on average.
  - ab5 library p99: 0.5–0.8 ms at throttle 1. At throttle 4 it was 1.7–2.0 ms in one run and 5.7–5.9 ms in
    a disturbed one (open 15.9 s, attach p50 4–5 ms, load 4.6).
  - The creator's move hop has a p99 tail of 340–380 ms. That is the creator's worker busy with room work
    such as seal and adoption, the same work that blocks the main thread in main mode.
- Open includes worker boot. Neither mode keeps a cold join under 5 s on this box.

### Data channels (condition C)

| Run | Channels created / received per page | Attach p50 / p99 (ms) | Opens/s |
|---|---|---|---|
| ab4 t1 | 92–332 / 92–332 | 0.3–0.5 / 9.4–12.6 | 6.9–8.5 |
| ab4 t4 | 103–394 / 103–394 | 0.8–1.1 / 11.2–20.1 | 3.9–9.4 |

- Each page owns 3 peer connections and makes 17 signalling calls. There are no synthetic opens.
- Attach latency is measured from `createDataChannel` in the worker to the transferred channel attaching
  there (one page round trip). Received channels need no round trip.

### Stop order

- What the page lends a worker is released only from `onCrash`.
- `onCrash` runs after `worker.terminate()` and after the client stopped handling the session's messages.
  This is pinned by `stop-order.test.ts`: a slow but alive worker is never declared crashed.

## Guarantees touched

- **G4.** Session ids on every message; a reopened worker is a new session on a new port. A terminated
  worker's late messages cannot reach the page.
- **G12, G13.** Unchanged: the room's IndexedDB connections and Web Locks live in the worker, the
  identity lock on the page. A terminated worker releases its locks and connections the way a closed
  tab does.
- **G15, G16, G17.** The room's durability is unchanged, and crash outcomes are resolved from durable
  state only (condition A).
- **G21.** The bridge is bounded, and so is what it streams. The session diagnostics' event log is capped
  at 256, with a dropped count, and is read on demand:
  - calls in flight (256);
  - page handles (65,536);
  - cause depth (4);
  - host value depth (16);
  - arguments per command (64);
  - stream values: one per stream per frame.
- **G26.** No safety check moved or relaxed: the worker runs the same room code.
- **G28.** The smoke test passes on Chromium, Firefox and WebKit (Playwright builds). Real Safari and
  Firefox stable devices are a follow-up (condition D).

## Follow-ups

- **D.** Device checks on real Safari and Firefox stable. The Playwright WebKit and Firefox builds pass
  the smoke test, and the spike's probe showed data-channel transfer works there.
- Canvas and Chat adoption. Their pages mix the room and the DOM in one module, so each needs a room API
  module like Grid's `v3-zone.ts` first. The package itself is generic.
- The three.js example can start on the worker page from day one.
- Data-channel churn of 4–9 opens/s, one libp2p stream per message, is the largest library item on the
  page in both modes. Stream reuse is a separate network track.
- ab3's main-thread t4 run failed once on `V3RoomAdoptionHoldExpired` (120 s), and its rerun passed.
  Recorded by the coordinator as main-thread adoption starvation under 4x throttle.
