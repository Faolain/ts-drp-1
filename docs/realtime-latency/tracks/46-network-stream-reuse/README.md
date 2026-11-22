# Track 46: direct messages reuse long-lived session streams

Branch `perf/network-stream-reuse` (on `perf/integration-7` a3b011da).

## Problem

Every direct message (`DRPNetworkNode.sendMessage`) opened its own libp2p stream. Over WebRTC that
costs:
- a new RTCDataChannel, created on the main thread;
- a multistream-select round trip;
- a FIN/FIN_ACK close.

Measured on the box, base, step 1:

| Measure | Value |
|---|---|
| RTCDataChannels per page | 2.8/s in Grid, 4.9/s in Chat; 83-90% of them were `/drp/message` |
| Send to frame at the peer | p50 7-8 ms, p95 24-28 ms |
| Of which stream setup | p50 6 ms |
| CPU per message (native, fresh stream) | 2.4-3.6 ms |
| CPU per message (native, one reused stream) | 0.3-0.46 ms |

Since 0b44e90f, `DRP_MESSAGE_PROTOCOL` was also registered with the sync protocols under a 3-stream
limit. A 4th concurrent direct message on a connection was reset. With no abort signal,
`sendMessage` swallowed that failure, so it vanished. A burst of 8 delivered 75 of 200.

## Change

**Owner.** `DirectMessageSessions` (packages/network/src/direct-sessions.ts) is the single owner of
direct transport. Its wire constants are in packages/network/src/direct-message.ts.

**Classes.** Each connection has at most one lazily opened, long-lived stream per traffic class:

| Class | Protocol | Frames | Window | Sender queue |
|---|---|---|---|---|
| rt | `/drp/message/1.0.0/session/rt` | ≤ 16 KiB | 32 frames / 256 KiB | 64 frames / 512 KiB |
| bulk | `/drp/message/1.0.0/session/bulk` | ≤ 4 MiB | 2 frames / 4 MiB | 4 frames / 8 MiB |

The window is fixed by the protocol version, so changing it means a new protocol id.

**Flow control.**
- The receiver admits each frame to its message queue, then grants credit back on the same stream.
- A slow receiver therefore holds at most one window (G21), and nothing is dropped by overflow (G23).
- A full sender queue refuses with a typed error.

**Prefix bounds.** Both readers bound the length prefix (`boundedLengthDecoder`, stream.ts).

**Completion.**
- A send resolves when the stream accepts its frame.
- An acknowledged send (`sendMessage(peer, message, {acknowledged: true})`) resolves only once the
  receiver admitted the frame to its message queue. On a session the receipt is the receiver's
  cumulative credit, since it admits in order; on legacy it is the receiver closing the stream after
  admission. A reset or close before the receipt rejects it (`DIRECT_SESSION_RESET`), and an abort
  while waiting for it rejects at once. The targeted retained replay (`republishRetained`, v3-live)
  asks for it, because it paces itself by awaiting each row.
- An abort before the write starts removes the frame.
- An abort during the write completes the frame, then rejects the caller.
- A reset rejects the frame being written; later frames move to a reopened stream.
- A connection close rejects everything queued on it.
- A failed send is always a typed `DirectMessageSendError`. The interval-discovery empty catch is
  removed.

**Compatibility (G25).**
- `DRP_MESSAGE_PROTOCOL` keeps its own handler with an inbound bound of 3. Each stream may buffer
  4 MiB, so the bound caps buffering at 12 MiB per connection.
- A peer without session support gets legacy one-frame streams, at most 2 concurrent per connection.
- Three session failures within 10 s, or three failed opens in a row, put the connection on legacy
  for 30 s.
- Sync-family messages always use the legacy id, which is the negotiated sync fallback.
- Sync itself is unchanged.

**Evidence.** `isDirectMessageProtocol` accepts the legacy id and both session ids. Room ingress,
creator selection and E1 ephemeral use it. Heads-chunk is still refused.

**Random-peer send.** `sendGroupMessageRandomPeer` sends through `sendMessage`. It now rejects
(typed) when the dial fails.

## Evidence

**Tests.**
- Network suite: the same 9 tests fail as at base (pre-existing).
- node and interval-discovery: 1166 pass (base 1165). The only failure is the pre-existing
  `unit.test.ts`, which does not load.

New tests:
- packages/network/tests/direct-message-sessions-red.test.ts: 16 tests on two genuine nodes.
- tests/track-46-direct-message-callers.test.ts: 16 tests covering evidence consumers and per-caller
  completion pins.
- packages/interval-discovery/tests/discovery-response-failure.test.ts.

**Browser A/B.** Chromium on the shipped Grid and Chat pages, 10 epochs, 3 interleaved pairs on
one box. Values are medians of per-run values. The raw tables are in
.logs/realtime-resume-2026-11-10/netreuse/ab1-grid.txt and ab1-chat.txt.

| | Grid base | Grid branch | Chat base | Chat branch |
|---|---|---|---|---|
| RTCDataChannels created per second (both pages) | 6.6 | 0.6 | 9.3 | 0.9 |
| createDataChannel main-thread ms per run | 97 | 18 | 137 | 9 |
| Send resolve p50 / p99 ms | 4.3 / 37 | 0.4 / 1.6 | 4.6 / 41 | 0.4 / 1.4 |
| Send to frame at peer p50 ms | 3.6 | 1.1 | 3.8 | 1.2 |
| Send to frame at peer p95 ms | 19.6 | 8.6 | 21.4 | 20.4 |
| Send to frame at peer p99 ms | 43 | 76 | 50 | 135 |
| Move input to remote render p50 / p95 | 15 / 32 | 15 / 32 | | |
| Placement or issue p50 | 490 | 600 | 230 | 250 |
| Placement or issue p95 | 3000 | 3600 | 3000 | 1900 |
| Rollover issue, creator worst per window, p95 | 5974 | 5610 | 4969 | 4761 |

The p99 tail of send to frame got worse in 4 of 6 branch runs. The slow samples are bursts of 7-15
V3 envelopes to one peer within 200 ms, from retained replay. Those bursts now go through one stream
in order, where before they were spread across parallel channels.

**Native micro benchmark.** `sendMessage` between two nodes over ws, 2 interleaved pairs. CPU covers
both ends, in one process. Raw: netreuse/micro-ab.txt.

| | Base | Branch |
|---|---|---|
| Sequential p50 / p99 ms | 1.61 / 5.56 | 0.52 / 2.19 |
| Sequential CPU per message | 3.06 ms | 1.43 ms |
| Paced at 30 Hz, p50 / p99 ms | 3.17 / 7.30 | 1.63 / 4.43 |
| Burst of 8, delivered | 75 of 200 | 200 of 200 |

A bare reused probe stream costs 0.45-0.8 ms of CPU per message. The rest of the branch's 1.43 ms is
the per-frame credit write, the dial lookup and the message codec.

**Native scorecard.** Grid, one writer, 12 rollovers. Two interleaved pairs plus one branch run with
diagnostics. Raw: netreuse/sc-ab.txt.

| | Base runs | Branch runs |
|---|---|---|
| Issue outside rollover window, p50 | 1424, 994 ms | 449, 166, 696 ms |
| Creator admission of member moves, p50 | 3.4, 5.1 s | 101.6, 110.9, 4.8 s |
| Creator admission of member moves, p95 | 100.2, 11.1 s | 107.9, 116.1, 15.2 s |
| Send to frame at peer p50 / p95 (diagnostics runs) | 10.4 / 76 ms | 17.1 / 111 ms |

## What did not move, or moved the wrong way

- The durable path stays rollover-bound. Grid placement and Chat issue tails are seconds, set by
  seal, adopt and install, and run-to-run spread is larger than any transport effect on them.
- Movement input to render is unchanged at loopback; the ephemeral channel was already its own path.
- In the native process, where the event loop p99 is about 200 ms, a session frame reaches the peer
  later than a fresh stream did. One likely cost: lpStream reads each length prefix one byte at a
  time, so every frame takes several event-loop turns. This is not yet verified.

## The two regressions, explained

**Admission rejections (native scorecard).**
- With every rejection site labelled, they are the creator V3 plane's 32-job input pool
  (`input-pool-refused:retained`) and gossip queue (`gossip-queue-full`) refusing retained-replay
  copies. No frame was received more often than it was sent, and no session reset, so transport
  duplication is ruled out.
- Cause: `republishRetained` paces its targeted replay by awaiting each row's `sendMessage`. On the
  legacy protocol each row paid a stream negotiation (75-255 ms under load). A session send resolved
  on the local write, so the whole retained window landed at once, the pool refused copies, and the
  Track AA delivery repair asked for the window again. Targeted transmits rose 3.1x (511 vs 163).
- Fix: the acknowledged send above. RED: four tests in direct-message-sessions-red.test.ts and the
  pin "each targeted retained row waits for the target's receipt" in
  tests/track-aa-retained-replay-owner.test.ts. Targeted transmits now match base (198 vs 191,
  168 vs 169).
- What remains is not track 46's: base run d5-2 refused 33 copies the same way, during a 76-row
  replay burst. A replay burst is not bounded to the target's free room; the slower legacy transport
  only made it rarer. Plane refusals per run (d4 and d5, 4 runs per arm): base 0, 0, 33, 0; with the
  fix 25, 26, 0, 0; with framing 66, 74, 33, 0.

**Rollover `SUBSTRATE_FAILURE` (browser Grid).**
- The creator logged `received-maintenance-custody` (a received append gave up its replacement
  custody) and 1 ms later `creator recovery role transfer source failed ... ahe-rejected
  SUBSTRATE_FAILURE`. A base run had the same custody refusal without the failure: a race.
- The race is older than track 46. In three more diagnostic pairs (sf1), the branch arm never
  failed, but one base run did: a received append's maintenance capture was refused, and 14 ms
  later the same recovery role transfer source failed with `internal-invariant`. That base run then
  failed outright (a placement refused with `creator issuance maintenance authority is
  unavailable`).
- Every AHE read on a room database joins whichever native read reservation is held there
  (native-read-reservation.ts). The received append held one; the close's source acquisition
  borrowed it. When the holder released it, a read queued for the view's next turn was rejected
  `NATIVE_READ_RESERVATION_RELEASED`, and one started while the release completed failed
  `assertOpen`. Both surfaced as `SUBSTRATE_FAILURE`, although IndexedDB never failed. Faster
  retained delivery made the overlap more frequent.
- Fix: a released (not failed) view is ignored while it completes, and a queued borrowed read runs on
  its own readonly transaction. The holder's own checks still refuse; a natively failed view still
  fails its readers. RED: packages/storage-browser/tests/held-view-release-red.test.ts.

## Remaining

- More pairs, to separate the two "not yet explained" items from noise.
- Possible transport follow-ups:
  - read frames from the byte stream in bulk rather than byte by byte;
  - write several credited frames per drain (writeV);
  - grant credit per half window instead of per frame.
