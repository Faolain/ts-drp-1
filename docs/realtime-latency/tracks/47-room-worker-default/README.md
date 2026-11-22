# Track 47: the shipped apps host their room in a room worker by default

Branch `feat/room-worker-default` (from 03dd3e55). Not merged; the browser A/B below decides it.

## Problem

Track 45 made the room worker an opt-in (`?roomWorker`, Grid only). With the room on the page's main
thread, a real-time page shares one thread with the node, libp2p, admission, the codec, signing and
IndexedDB; Profile M allows 2 ms of main-thread work per frame, and Track 45 measured 18–23 ms
(traced p99) on the main thread against 3.6–4.4 ms with the room in the worker.

The decision is to make the worker the default for Grid, Canvas and Chat, but only once the FPS
harness measures honestly on a slow CPU. It did not: `BROWSER_FPS_CPU_THROTTLE` throttled the page
targets only (DevTools `Emulation.setCPUThrottlingRate`), so a 4x worker run measured a fast worker
behind a slow page.

## Change

1. **The harness throttles every thread it measures, and proves it.**
   - CDP cannot throttle a worker: blink refuses `setCPUThrottlingRate` on worker targets, and its
     throttler is one per renderer process, slowing only the first thread that set it.
   - The default mechanism (`BROWSER_FPS_CPU_THROTTLE_MODE=process`) duty-cycles every renderer
     process with SIGSTOP/SIGCONT (4 ms quantum), so each page main thread and each dedicated worker
     runs 1/rate of the time. `cdp` keeps the old mechanism for comparison with earlier runs.
   - Self-check (`summary.cpuThrottleSelfCheck`): a fixed loop is timed unthrottled on a page and in a
     worker, then on every page and every dedicated worker after open (and on workers that appear
     later). Each must be at least max(1.5, rate/2) times slower than its reference, and the number of
     throttled workers must equal the number of workers, or the run fails whatever
     `BROWSER_FPS_GATE` says. In `cdp` mode a worker-hosted room fails it, as it should.
   - A throttle on Firefox or WebKit fails the run instead of reporting unthrottled numbers.
   - Every dedicated worker gets a 10 ms heartbeat from play start (`summary.workers`): its stalls of
     50 ms or more (workers have no long-task entries) in and outside rollover windows, and its total
     lateness. Report only.
   - No threshold changed.
2. **Grid, Canvas and Chat host the room in a room worker by default.** `?mainThread` opts out, and a
   browser that cannot host the room in a worker falls back to the main thread. Canvas and Chat
   follow Grid's pattern: the room without the page (`canvas-room.ts`, `chat-room.ts`) runs unchanged
   in both runtimes; the page renders the room's views and calls it through a small interface; the
   worker app is a `defineRoomWorkerApp`. What a worker lacks stays on the page and crosses as a hook:
   the room-head authority (with its native reservations released when the worker stops) and Chat's
   Writer-replica mark in localStorage. The page's session snapshot stays synchronous (a `session`
   stream), so the tests and the harness read it as before.
3. **The bridge's per-frame meter is the package's** (`createRoomWorkerFrameMeter`), so every app's
   `?roomWorkerMeter` reports the same library/render split.
4. **The browser gate exercises the worker.** `browser-app-fps.pw.ts` opens every app in its worker
   (metered) unless `BROWSER_FPS_ROOM_WORKER=0`; `gate-browser.sh` passes `FPS_ENV` to every run.
5. **Formal model** of the page↔worker ordering and handoff:
   `packages/room-worker/formal/room-worker-bridge.qnt` ([README](../../../../packages/room-worker/formal/README.md)).
   Five properties (no unadmitted display, read-your-writes, display only from the current worker, no
   stream value after close, commands in the page's order) hold for the design: simulator 100,000
   traces x 30 steps, Apalache to 8 steps. Each of five broken variants (reply before flush, no
   session check, optimistic display, emit after closed, reordered commands) gives a counterexample in
   both.

Tests changed only because the product default changed or code moved, never their assertions:
suites that read a room through the page module's bindings (track-x, track-w2) or drive Grid's
main-thread zone pin `?mainThread`; source-inventory tests read the moved room modules.

## Evidence

- Light: tsc and vite builds of the three apps; `packages/room-worker` 46/46; the room-worker v3
  binding tests 8/8; per-player-room-database 9/9; the d110c callback inventory matches for Canvas and
  Chat (its two other failures are on the base too).
- Browser A/B: pending (the Mac is too loaded for browser runs; the runs are listed in the branch's
  hand-off).

## Risks

- Cold join: the worker loads the room's whole bundle on open, and the page chunk still carries the
  v3-room package for its error classes.
- Storage in workers: the worker opens the room's IndexedDB stores (OPFS is not used); the page keeps
  the identity Web Lock and localStorage. The worker refuses to open (and the page falls back to the
  main thread) when it lacks `RTCDataChannel`, `indexedDB`, `WebSocket` or `crypto`; whether the
  browser can transfer a data channel into it is not probed before the first channel.
- Firefox and Safari: Track 45's real-browser tests pass on Playwright's Chromium, Firefox and WebKit;
  real Safari and Firefox devices are still open (row 87, condition D). A browser without module
  workers throws on `new Worker(..., { type: "module" })`, which the page treats as a failed start,
  not as a fallback.
- The process throttle needs `SystemInfo.getProcessInfo` (Chromium) and POSIX signals; its 4 ms
  quantum adds up to that much jitter on every thread.
