# Track 46: direct messages reuse long-lived session streams

Branch `perf/network-stream-reuse` (from `perf/integration-7` 9f83f1a7).

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
- In two of three native branch runs, the creator admitted the member's moves about 100 s late.
  These runs logged 297 stage-less `::v3-ingress admission-rejected` warnings, against 1 at base.
  One base run already had a 100 s p95. Not yet explained.
- Two of three Grid browser branch runs logged one creator rollover failure (`SUBSTRATE_FAILURE`,
  retried). No base run did. Not yet explained.

## Remaining

- More pairs, to separate the two "not yet explained" items from noise.
- Possible transport follow-ups:
  - read frames from the byte stream in bulk rather than byte by byte;
  - write several credited frames per drain (writeV);
  - grant credit per half window instead of per frame.
