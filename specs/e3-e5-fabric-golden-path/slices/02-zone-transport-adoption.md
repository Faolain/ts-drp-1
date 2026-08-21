# Slice E3-02: Zone Transport Adoption

## Contract

Two real zone clients exchange movement through the genuine raw channel while
the existing E2 owner remains the only authority. Durable `placeBlock` and room
reconnect remain unchanged.

## API seam

For v3-authorized rooms, `NodeEphemeralAdapter` becomes the sole lane selector:

- `reliable-unordered` uses the current signed GossipSub/authenticated-stream
  path;
- both unreliable classes use `openUnreliableWebRtcRoute`;
- raw ingress enters the same existing ephemeral listener with the
  authenticated remote peer ID.

The pre-existing public legacy `DRPNode.openEphemeral` mode has no E2 authority
provider. Preserve it on its reliable carrier for every class label, give it no
raw route or raw ingress, and exclude it from all E3 evidence. That preservation
is not a fallback in the authorized v3 path.

Remove the E3-00 transitional reliable carrier for unreliable classes. Missing,
unready, closed, or backpressured raw delivery returns `false`; it does not
fallback.

No `V3RoomSession.openEphemeral` API change is expected. The route derives from
the existing object/topic separation and is not caller-selected authority.
The adapter reconciles raw links only for peers that are both currently
E2-authorized and already connected through genuine WebRTC. Neither set alone
is sufficient, and reconciliation never dials.

## TDD and acceptance

Retained integration cases cover wrong route, peer, anchor, ACL, epoch, writer,
sequence and frame; disconnect/reconnect generation; rate/replay budgets; route
cleanup; zero durable movement vertices; and exactly one durable vertex for one
`placeBlock`.

Migrate the existing E2 and zero-durable-vertices controlled network fixtures to
the same standards-shaped raw-route owner used by the adapter. Their publishes
must succeed through that route and loop genuine raw ingress back through the
existing authority listener. Do not preserve their old GossipSub/direct output
as a v3 fallback. Also retain explicit injected-generic-network cases where the
raw owner is `null` and authorized raw sends fail closed.

The browser case must assert the actual local and remote channel properties,
authenticated peer attribution, zero fallback, movement convergence, one
client disconnect/reconnect, and durable convergence afterward.

Target: two-client case <4 minutes.

## Human surface

Add `examples/grid/fabric.html` and a dedicated workbench entry. Show peer and
E2 authority summary, raw link state, actual channel properties, raw counters,
fallback count, and durable vertex count.

Capture the two-client view, run `screenshot-critique`, compare with the prior
zone view using `compare-screenshots`, then open both with `preview-shots` for a
non-blocking five-minute review window. Record the decision and close Preview.

## Must stay green

Shared v3-room chat/reconnect, zone durable state, E2, T1–T4, zero durable
movement, build/type/static, and current grid artifact.

## Feedback that changes this slice

Only genuine browser evidence that the raw link cannot coexist with the
current authenticated relationship. Visual polish beyond readable telemetry is
deferred.
