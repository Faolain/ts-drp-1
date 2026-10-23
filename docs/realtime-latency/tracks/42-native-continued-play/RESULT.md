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

## Sustained harness preparation

The same probe now accepts a configurable epoch count and keeps exactly 32 Grid
slots after warmup. Each author owns sixteen disjoint slots; its accepted writes
advance a separate last-value oracle. Promise completion order between authors
cannot decide conflicting state. A loss probe targets a newly changed value and
its exact digest, so an earlier value in that slot cannot satisfy repair.

Detailed observations flush in batches of at most 512 rows and at every epoch.
Only two channel bindings, 64 recent raw sends, 64 reconciliations per live raw
route, and 256 recent timer-delimited CPU intervals per step remain in memory.
Full interval records stream to disk. Per-epoch signed-envelope observations are
cleared and successor material ports close after installation. Every epoch records
exact receiver states and a read-only census of every physical SQLite, WAL and
shared-memory file, including every user table of every database.

The [four-epoch preparation receipt](evidence/sustained-preparation-08/manifest.json)
passes in **observation mode** on source `77e641a3` plus its preserved harness patch:
59 accepted operations, 32 final slots, three quiet automatic repairs, and reopen
at epoch 2. Each repair observes two requests, one lost gossip copy and one lost
direct answer. Both genuine network nodes and their identities remain alive across
reopen; all room and channel objects are recreated using noncreating storage opens.
Exact state is checked immediately before and after reopen, followed by a separate
baseline requiring progress at each receiver. The timer continues offering ticks
during reopen and labels unavailable offers explicitly. Startup request schedules
are aged out before each periodic-only repair probe.

The smoke retained at most 512 observation rows, 64 raw sends and two raw routes;
it flushed 46,703 detailed rows in 94 batches. Physical files grew from 33 to 43.
These are preparation observations, not a long-run plateau. The largest timer gap
was 2,785 ms spanning the fourth maintenance operation, with 3,101 ms of process
CPU between callbacks. That maintenance step itself used 2,771 ms wall time and
3,089 ms process CPU with zero callbacks. Process CPU includes every thread and
can exceed wall time. A separate 1,327 ms startup gap remains unattributed to a
specific owner in this receipt. Neither number is a final-source performance result.

[Independent review](evidence/sustained-review/manifest.json) found one early-reopen
defect: recipient signing storage is normally created by later maintenance, so a
strict epoch-1 reopen prevented that store's first acquisition. Initial setup now
materializes that empty owner before opening rooms; every acquisition after reopen
remains noncreating. The receive negative control suppresses only receiver 1's
post-transition observations and fails at its own baseline assertion. Unit controls
also reject a stale value with all 32 IDs still present and check exact observation
flush coverage and bounded raw-route history.

The [corrected default run](evidence/sustained-default-11/manifest.json) passes three
epochs, 51 accepted operations and strict reopen at epoch 1, including later
recipient maintenance. Typechecking and six observation/joined-failure controls
pass. Its explicit warmup scopes expose a separate scheduling boundary: 32 public
issues in sixteen sequential author pairs take 990 ms wall time and 1,080 ms
process CPU, with one timer callback and zero ephemeral receives. Subsequent
convergence takes 1,194 ms wall time and 1,256 ms process CPU, with three callbacks
and two receives per peer. Absolute issue times and complete timer CPU records
preserve the distinction between issuing and catching up. This remains an
observation-mode pass on the earlier production source.

The final campaign still waits for reviewed responsiveness and authenticated rejoin
changes to compose. Run 300 epochs with `ACTIVE_CONTINUED_PLAY_EPOCHS=300`,
`ACTIVE_CONTINUED_PLAY_REOPEN_AT=30`, `ACTIVE_CONTINUED_PLAY_REPAIR_EVERY=25`
and `ACTIVE_CONTINUED_PLAY_REQUIRE_PROGRESS=1`; leave inspector profiling disabled.
This requires both receivers to progress inside each transition as well as during
the surrounding baselines. The existing 100 Hz per-peer offer schedule measures
actual callbacks and deliveries, including timer starvation. Reopening at 30 leaves
270 uninterrupted epochs for ordinary WAL behavior; inject no checkpoint or vacuum.
Keep the Canvas/Chat conservation paths and larger per-epoch capacity axis separate.
