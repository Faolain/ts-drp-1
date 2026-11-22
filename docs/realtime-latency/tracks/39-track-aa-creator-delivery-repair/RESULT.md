# Quiet delivery repair

A successful history-request send says nothing about whether its answer arrived or
was admitted. Recovery must also cover a lost first or final copy that produces no
observable refusal or missing dependency. The live plane therefore binds a weak
repair probe at activation, and the room transport retains a bounded periodic
request alongside work triggered by observed gaps.

The creator rotates connected routing peers; recipients ask their creator. Peer
identities are routing hints. Returned rows still enter ordinary authenticated
admission. An authenticated held-row target ends only when the current plane's
admitted index contains its digest. Raw refusals retain no payload or digest and
cannot claim admission. The connected-peer sweep covers hints that exceed the
remembered-peer budget without retaining another roster.

[The room transport](../../../../packages/node/src/room-network.ts) owns request
spacing, fair turns, backoff, bounded peer and target records, and native send
joins. Cancellation requests native termination; the send remains charged until
its actual promise settles. Plane retirement revokes the weak probe and pending
work. A successor starts its own periodic schedule.

[The live plane](../../../../packages/node/src/v3-live.ts) owns admission and
retained publication. Duplicate copies are decoded only after bounded input
capture; an already admitted digest then releases its temporary reservation before
waiting on the FIFO. Targeted history responses use the existing replayable-egress
owner. Repeated requests for an active target join that native replay, including
its snapshot, cancellation and close lifetime. Distinct target keys remain bounded
by the native egress pool. They are released after native settlement, including
when retirement has already aborted the send.

## Evidence and limits

The initial implementation failed quiet lost-answer tests and silently lost
first/final-copy tests in both delivery directions and both profiles. Independent
review additionally reproduced uncancelled direct dialing, premature native-slot
release, authenticated-priority starvation, pre-admission duplicate decoding,
repeated targeted replay accumulation, and a sweep-only peer cooldown bypass.
Each has a focused regression proof in the Track AA tests.

The final owner checks show that duplicate requests share one native replay,
distinct replay targets saturate the existing pool without exceeding it, and
retirement aborts while preserving the native join. The unchanged fairness test
admits every healthy Writer row while another Writer blackholes requests. The
browser proof verifies eventual recovery of an 80-block burst after the creator
pauses; its loaded-host timing is not a game-rate result. Exact observed results
and their scope are recorded in [evidence.json](evidence.json).

The original full-journal replay held the durable FIFO across network sends:
80 rows with 100 ms successful sends occupied the gate for 8,292 ms and delayed
issue for 8,268 ms. The follow-up moves physical sends outside that FIFO. All
active target and broadcast streams share one bounded immutable journal DATA
prefix; each target retains only its captured row-count boundary. Broadcast demand
joins one pending full round, so a peer joining midway receives the earlier rows.
Each round has its own completion promise; continuous later demand cannot keep an
earlier caller pending. New rows extend the shared prefix only after native
validation of the old prefix; failed capture discards the incomplete suffix.

Every row still acquires fresh native head/floor custody, authenticates its
signature and ACL, and rereads local-issued correspondence before sending. Native
reservations end before the send. A completed close authenticates its exact signed
successor references and native ancestry on each turn. If that close still owns
the journal transaction, replay borrows a joined child of the original custody;
parent revocation rejects that child and child cancellation preserves the parent.
This mechanism has fake-indexeddb coverage; native browser-engine parity remains
unverified. The close owner pauses future replay reads before draining the FIFO;
waiting readers hold no native custody and never block the close inside that FIFO.
Adoption pauses its predecessor and replacement through native verification, source
release and successor readiness. Standalone readiness uses the same phase; malformed
offers rejected before source custody leave replay available. Only the original
transition owner can restore its prior phase after joined completion. The completed
close resumes sealed reads. A failed or ambiguous close leaves
reads unavailable until the same close owner successfully retries. Retirement
wakes waiting readers and clears the prefix on both ordinary deactivation and
hot successor handoff, without discharging physical sends. Already captured signed
row DATA is reusable
across unrelated appends or later physical journal corruption; it is not current
admission or native authority. A new demand validates the current journal again.
This avoids the measured quadratic alternative: rereading a page after each of
64 appends caused 64 complete scans containing 6,240 rows.

The registration owns one prefix, bounded by existing journal image/row limits;
UTF-16 strings and scalar data are charged as well as detached bytes. Encoded
messages share the existing pending-byte ceiling, and the original 32-slot egress
pool bounds streams, one queued read and one native send per stream. Both numerical
reservations belong to the network and stable room topic across epoch handoffs.
Two held predecessor sends leave only 30 current-epoch slots; releasing an epoch
does not replenish native credit. The regression failed before this shared owner
and passes with it, including exact byte conservation and reuse after native join. Callback
mutation cannot reach prefix bytes. Retirement clears the prefix in place while
actual sends and their charges remain joined. No promise timeout discharges a
running native send. Current-room shutdown awaits this same pool's idle completion,
including sends started by retired predecessors. Every zero-to-nonzero admission
starts a fresh idle generation; shutdown rechecks after each wake. The bound is
per network instance and stable room topic. Hosts must await room shutdown (or
joined deactivation of the last plane) before discarding that network; it does not
bound arbitrarily many separately created network instances.

The exact combined baseline replayed 82 rows in 8,401 ms and delayed the first
durable issue by 8,389 ms. The shared-prefix native probe replayed 82 rows in
9,248 ms with the same
100 ms per-send delay. Twenty concurrent durable issues had p50/p95/p99
79.22/87.44/88.09 ms; the first took 76.42 ms. Recipient observation had
92.92/103.79/326.64 ms, including one tail outlier. A separate 129-row replay took
153.24 ms. A replay of 65 captured rows overlapping 64 new durable issues
completed with **zero full-journal scans**. These use SQLite room sessions and the production room transport over an ordered
in-memory network during a quiet test window, not browser, WebRTC, bandwidth or
FPS measurements.
These measurements precede the subsequent sealed-custody, close/adoption lifecycle and broadcast-round
correctness fixes; timing has not been repeated on that final candidate. Read-turn
maxima also include fixture population/automatic repair; they are not a
separate cold-capture latency distribution. Exact samples and limits are in
[retained-replay-performance.json](retained-replay-performance.json).

The requested 512-row baseline on the historical pre-H5 combined tree
(`6cd4c567`) remains a failed capacity probe: after 357 user
issues, 358 rows were accepted and further issue refused because the creator
maintenance proof reserve was exhausted. Seal closed all 358 rows and prepared
epoch 1; the subsequent adoption-or-next-issue block failed with the same reserve
error. That original run did not distinguish those phases. The opt-in regression
now logs adoption, next issue, normal maintenance and retry separately. No
capacity limit or load was changed to conceal the refusal. Capacity finishing,
three-browser replay currency, and larger steady-state performance remain separate
acceptance work. This historical refusal is not a claim about the later integrated
H5 finishing changes.

The affected replay, lifecycle, scheduler and fairness controls pass. Independent
review findings about extracted private helper dependencies were repaired without
weakening their behavioral assertions. Three older readiness/native-readback
controls fail identically on unchanged `6cd4c567` and this candidate: one argument
assertion and two 120-second timeouts. The comparison uses identical test bodies
and direct worktree-local node sources; its exact results and source hashes are
recorded in the performance evidence. Those historical whole suites are not
claimed green.
