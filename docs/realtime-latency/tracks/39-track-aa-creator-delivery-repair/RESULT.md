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

**A single full-journal replay still holds the durable plane FIFO across network
sends. This is a confirmed performance blocker.** With 80 rows and a successful 100 ms delay per send, one replay occupied
that gate for 8,292 ms and delayed a durable issue for 8,268 ms. Eighty duplicate
requests shared that one replay. Coalescing prevents redundant queued snapshots;
it does not make a slow full replay suitable for interactive durable issue. The
ephemeral path was not measured in this proof.

The 512-row no-loss bandwidth probe did not produce a completed sample during the
loaded pre-coalescing run. It is an explicitly enabled measurement in
[the cost probe](../../../../tests/track-aa-periodic-cost.test.ts), with separate
issue, publication-drain and remote-admission phase telemetry for a serialized
combined-tree run. No steady-state bandwidth or FPS-readiness claim follows from
this change. Streaming work outside the durable FIFO and reducing unchanged
full-journal traffic remain separate performance work.
