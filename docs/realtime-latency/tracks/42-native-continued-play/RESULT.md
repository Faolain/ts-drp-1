# Native continued play: repair passes, responsiveness is RED

The native probe preserves all 21 accepted Grid placements across three successor
transitions and repairs a silently lost final move through the production room's
automatic retained-history requests. It does **not** establish uninterrupted play:
sealing and adoption consume substantial process CPU without servicing the 10 ms
movement timer. No ephemeral frame reaches either receiver during those transitions.

Two actual libp2p nodes communicate over localhost WebSocket connections. The fixture
delays genuine ingress by 20 ms, retaining its original authenticated message object.
After the startup request schedule ends, it drops the selected move's gossip copy
and the first direct repair answer. The next automatic request recovers that exact
digest without a manual replay or another durable move. Exact projected Grid state
is checked after each transition and maintenance attempt.

The unreliable datagram boundary is controlled in process; the room supplies the
actual current authority, ACL, frame codec, queues and sequence filtering. This is
not browser WebRTC or rendering/FPS evidence. Successor chunks and material use the
existing scripted transport over the genuine signed native export. Both peers run
in one process, so CPU and event-loop observations include both endpoints.

## Evidence boundaries

The latest [unprofiled composed run 06](evidence/active-continued-play-common-06/manifest.json)
uses `296cedf7` plus exact patch `539027aa…39532b5`, now committed as `0b62f984`.
It includes the reviewed capacity/bootstrap changes and the merged remote-observer
correction. It passed in 39.28 seconds with exact state and observed remote
admissions at both receivers. Automatic repair took 9.26 seconds and two requests.

The earlier [unprofiled run 03](evidence/active-continued-play-native-03/manifest.json) uses
production `37bb6080` plus exact patch `2109c51b…a88464c0`. The
[profiled run 05](evidence/active-continued-play-profile-05/manifest.json) uses the
same production source plus patch `325919d7…88293528`. Each directory preserves
the complete patch, observations, summary, sample records and terminal test log.
Run 05 additionally preserves nine scoped V8 CPU profiles. Both tests and their
joined cleanup completed with exit 0. Runs 03 and 05 predate the later common
capacity/bootstrap integration and the responsiveness implementation.

The machine is an Apple M1 Max with ten cores, Node 22.23.4, macOS arm64. Initial
load averages were 116.41/123.34/125.98 for run 03 and 114.18/119.44/122.36 for run
05; run 06 began at 139.54/125.61/123.19. Other live sessions owned the competing
jobs; they were preserved. Wall-time
numbers therefore describe a shared host, not an isolated latency benchmark.

| Unprofiled composed run 06 stage | Wall time | Process CPU | Timer callbacks | Ephemeral receipts |
| --- | ---: | ---: | ---: | ---: |
| Seal, three samples | 178–199 ms | 150–196 ms | 0 each | 0 each |
| Adopt, three samples | 297–385 ms | 276–365 ms | 0 each | 0 each |
| Install, three samples | 417–884 ms | 427–876 ms | 1–2 | 0 each |
| Third maintenance, with concurrent writes | 737 ms | 701 ms | 0 | 0 |
| Baseline before, 2 s | 2,001 ms | 209 ms | 169 | 338 |
| Baselines after, 1 s each | 1,001–1,003 ms | 82–200 ms | 85–87 | 170–174 |

Seal and adoption report event-loop utilization 1 with no timer callback. Their
own CPU contribution makes the responsiveness failure actionable independently of
host contention. Process CPU includes all threads and can exceed wall time.
Installation records two to four authority-mismatch drops per
transition while the peers intentionally occupy different epochs. Those correct
cross-epoch rejections are separate from timer starvation. Reinjected old-epoch
frames after installation are rejected by the current authority.

Run 06's largest actual timer gap is 878 ms; the event-loop monitor reports a
957 ms maximum. The first two creator maintenance requests return unsupported;
the third recipient request performs maintenance. The raw results preserve these
outcomes rather than counting every call as completed cleanup.

Run 03's first whole-run timer-gap sample includes room setup before the interval
was scheduled; its `timerMaxGapMs` is invalid. The per-step measurements above are
unaffected. Run 05 fixes that baseline, but profiler startup/stop and profile-file
output inflate whole-transition and whole-run timer gaps. Use unprofiled run 06
for current responsiveness, and the earlier profiles for attribution.

## Attribution and awaited boundaries

The [profile attribution](evidence/active-continued-play-profile-05/profile-attribution.json)
weights V8 samples by `timeDeltas`. It excludes inspector-stack samples only from
the derived attribution; the raw profiles preserve them. Inclusive weights
overlap, and profile line numbers belong to generated V8 scripts. These weights
are not absolute process CPU measurements.

At the third installation, `readCreatorRecoveryDependencyCensus` accounts for
about 33% of non-inspector inclusive sample weight. Classification, exact
settlement-completion checks, new issuance, canonical encoding and native issuance
reads are prominent below it. Adoption includes closed-data acquisition, native
bounded reads/currency checks, snapshot role inventory and recovery metadata.
Sealing includes the four concurrent writer issues, signing and close-generation
construction. Run 04, retained in `/private/tmp/active-continued-play-profile-04`,
shows the same owner families with different sampling proportions.

The existing orchestration already awaits many promises:

- `v3-room.sealEpoch` drains current work and publication before
  `creatorCloseHandle.close`; the close owner stages the snapshot, acquires its
  original recovery sources, constructs the next generation and completes seal.
- `performCreatorSuccessorAdoption` pauses retained reads, verifies and stages,
  begins the external floor advance, publishes, commits that advance, activates,
  rebinds the close owner, installs the projection, drains pending issuance and
  restores ordinary readiness.
- `installCreatorSuccessor` first receives and authenticates successor material
  and native recovery custody, then enters that same adoption chain.

Native SQLite methods execute synchronous `DatabaseSync` work; awaiting their
already-resolved results does not service the task loop. A responsiveness fix must
preserve native reservation lifetime, the original captured owners and checks,
joined revocation, and the atomic authority-publication interval. It must not
relax current ephemeral authority to conceal staggered-install loss.

## Harness review

Independent review found two measurement defects: the first timer gap included
unscheduled setup, and an aggregate post-transition receive count could hide a
one-way failure. Both are corrected. The reviewer's one-way observation mutation
passed the original test; the same mutation now fails specifically at receiver 1
after the first transition. The ordinary corrected run passes. The shared fixture
also avoids an `open`-options shadow introduced by common integration, and the
probe requires observed remote admissions at both receivers in steady operation.

The three joined-failure controls pass. A shared Phase 4b regression run has six
behavior passes and an unchanged stale exact-export-roster assertion failure;
the authority allowlist was not rewritten to match the current implementation.

The [common integration receipts](evidence/common-integration/manifest.json)
record a successful package build, 22 focused controls and both real SQLite
SIGKILL edges. Each disposable mutation worker exited by the expected kill after
COMMIT; each fresh recovery process exited 0, preserved state and resumed useful
issuance. The active issuance intent completed its exact frozen preparation before
any new same-cut selection. An earlier broad name filter also selected two other
failures (an undefined source-extraction binding and a 10-second timeout); that
failed log is preserved and is not reported as an all-green suite.

## Next combined campaign

After the responsiveness and authenticated rejoin changes compose, extend this
same native transport probe to 300 configurable epochs over 32 overwritten Grid
slots with an independent last-value oracle. Keep 100 Hz offered ephemeral ticks
and record actual per-receiver progress, process CPU, event-loop utilization and
current-authority mismatch separately. Exercise silent final-copy and first-answer
loss periodically without an explicit replay. Flush per-epoch samples and retain
only bounded counters/rings so the measurement harness itself does not grow with
the epoch count.

Count every physical SQLite, WAL and shared-memory file through the existing
read-only census. Explicitly reopen both peers at epoch 30, preserving transport
identities and recreating room/channel bindings, then continue for 270 uninterrupted
epochs. Require exact state before and after reopen. Use no inspector for final
timings. Keep the Canvas/Chat 300-epoch conservation paths and the larger-records
capacity axis distinct; this three-epoch probe closes none of those long-run gates.
