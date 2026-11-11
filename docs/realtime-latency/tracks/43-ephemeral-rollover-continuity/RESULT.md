# Track 43 result: the stream stays up across rollovers

Design and invariant: [README.md](README.md).

## Tests

RED came first, on the integration base, with deterministic counts (no wall clock):

- `packages/ephemeral/tests/rollover-continuity.test.ts`: an in-memory room of four peers (creator, two
  Writers, and X, who is removed at epoch 1). At the RED commit 3 of 5 failed: six rollovers with members
  installing one by one, both directions, and the per-sender floor. The two guards (X refused once the
  receiver installs epoch 1, members still on epoch 0 still accept X, replays refused, nothing two epochs
  away accepted; a foreign tuple is never accepted) passed before and after. Three more tests were added
  with the review fixes: a reliable frame overtaken by its successor-tagged frame is still delivered, no
  sequenced frame is delivered twice across an install, and the preceding tag is claimed only while some
  recipient has not been seen under the current context.
- `tests/ephemeral-rollover-continuity-native.test.ts`: genuine rooms on the native network, settlement
  profile, three rollovers; at each one the creator and a Writer exchange movement between adoption and
  install. RED: gaps at every adoption, 6 `authorityMismatch`, 4 of 7 frames received each way. GREEN: no
  gaps, 0 mismatches, 7 of 7 each way, and no durable vertex accepted during any exchange.

Changed test: `tests/creator-adoption-host-turn-native.test.ts`. After adoption it injected the Writer's
epoch-0 frame and asserted `delivered` unchanged and `authorityMismatch + 1`. That is exactly the
blackout: the Writer is still a writer under epoch 1 and the frame is from the epoch the creator just left.
Now: at the `activate` boundary (the frame first arrived while the creator had no bound authority, so it was
never delivered) it is delivered once and the same bytes again are refused; at every other boundary
(already delivered under epoch 0) it is refused; in every case `stale` rises by one and
`authorityMismatch` does not move. No removal or refusal assertion was weakened.

## Model

`packages/ephemeral/formal/ephemeral-adjacent-authority.qnt`, Quint 0.32 with Apalache 0.56.1
(8 steps), simulator 50,000 samples of 14 steps, seed 7. Every case gave the expected verdict:

| Step | Property | Expected | Simulator | Apalache (8 steps) |
| --- | --- | --- | --- | --- |
| shipped rule | safety (all six) | ok | ok | ok (29 min) |
| shipped rule | no refusal of an honest continuing writer | ok | ok | ok (8.6 min) |
| old single-context rule | safety | ok | ok | ok (9.6 min) |
| old single-context rule | no refusal of an honest continuing writer | violation | violation | violation |
| unverified ahead claim | verified context | violation | violation | violation |
| writer check against the previous ACL | authorized delivery | violation | violation | violation |
| no per-sender floor | sender monotone | violation | violation | violation |
| any past context accepted | bounded window | violation | violation | violation |

## Measurements

The fixed-rate scorecard (`tests/realtime-scorecard-rate-native.test.ts`): genuine native rooms in one
process, shipped rollover policy, 2 durable moves/s, every peer publishing movement at 30 Hz, 42 rollovers,
boat sandboxes (8 vCPU, RAM disk). "2 peers" is the creator and one Writer; "4 peers" is the creator and
three Writers. Delivery counts every frame published to an authorized peer.

| Build | Peers | Run | Delivery | Gaps > 100 ms | Max gap | `authorityMismatch` | Member installs failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base f9f7a582 | 2 | 1 | 91.84% | 272 | 919 ms | 1,522 | - |
| fix | 2 | 1 | **100.00%** | 152 | **203 ms** | **0** | - |
| base f1538d32 | 2 | 4 | 90.22% | 611 | 2,325 ms | 1,802 | - |
| fix (rebased) | 2 | 4 | **100.00%** | 304 | **371 ms** | **0** | - |
| base f9f7a582 | 4 | 1 | 81.83% | 11,274 | 11,108 ms | 25,044 | 2 of 128 |
| base f9f7a582 | 4 | 2 | 86.02% | 10,850 | 8,593 ms | 20,822 | 0 of 126 |
| fix | 4 | 1 | 77.63% | 15,433 | 169,904 ms | 42,027 | 4 of 118 |
| fix | 4 | 2 | 87.48% | 15,998 | 158,839 ms | 25,910 | 5 of 123 |
| base f1538d32 | 4 | 3 | 23.22% | 3,670 | 478,738 ms | 175,420 | 50 of 106 |
| fix (rebased) | 4 | 3 | 38.30% | 8,914 | 694,961 ms | 119,941 | 15 of 70 |
| base f1538d32 | 4 | 4 | 22.58% | 5,110 | 342,460 ms | 165,235 | 71 of 127 |
| fix (rebased) | 4 | 4 | **99.98%** | 16,661 | **590 ms** | **27** | 2 of 128 |

No run accepted a durable vertex during the ephemeral-only window.

Four-peer runs are dominated by a durable-path fault that is not this change: members' successor installs
fail ("creator recovery dependency hold unavailable", "database is locked", adoption hold expired after
120 s), members fall two or more epochs behind the creator, and every frame between peers that far apart
is refused by design. It strikes base and fix alike (runs 3 and 4 ran base and fix at the same time on two
sandboxes; in run 4 the base collapsed and the fix did not) and is much more frequent at f1538d32 than at
f9f7a582. Raw delivery percentages for four peers therefore measure install health, not this change.

To separate the two, every recorded gap is classed by the largest sender/receiver epoch distance at any
moment inside it (from the run's rollover timeline; runs 1-3 record the first 2,000 gaps over 100 ms,
run 4 records all of them):

| Run (4 peers) | Base: gaps > 1 s inside the window | Base: max | Fix: gaps > 1 s inside the window | Fix: max |
| --- | --- | --- | --- | --- |
| 1 (first ~170 s) | 90 | 10,656 ms | 0 | 354 ms |
| 2 (first ~180 s) | 86 | 8,457 ms | 0 | 329 ms |
| 3 (first ~150 s) | 64 | 9,451 ms | 0 | 497 ms |
| 4 (whole run) | 154 | 17,114 ms | 0 | 590 ms |

Among the recorded gaps, no fix gap inside the window (peers on the same or adjacent epochs) exceeds 590 ms;
the fix's longer gaps (runs 1-3, after the recorded span) fall in the stretches where installs had failed
and members were two or more epochs behind.

The count of gaps over 100 ms goes up with the fix because many more frames are delivered: a blackout is one
long gap, while continuous delivery on a busy event loop produces many short ones. All peers run in one
Node process; its event loop p99 is about 130 ms during play, which is what the remaining 100-600 ms gaps
reflect.

## Residual risks

- The window is one epoch. A member two or more epochs behind is still blacked out, as before.
- "Previous context" is the last context the channel itself observed (lazily, on publish or receive).
  A channel that saw no traffic during an epoch holds no window for the next change.
- Unordered (reliable) frames had no replay protection inside an epoch; inside the window that class
  extends to the adjacent epoch until the sender is seen under the receiver's current context.
- A sender with no floor when the 128 floors are full gets the single-context rule; a reopened sender in
  that state may keep stale watermarks until pruning.
- Version-3 frames are refused (malformed) by builds without this change; mixed-version rooms lose the
  window frames, not safety.
- The track 38 pending-floor model still states the single-context receive rule; it carries a note that
  this track supersedes that part.
