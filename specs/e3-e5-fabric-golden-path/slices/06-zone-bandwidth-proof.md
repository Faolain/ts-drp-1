# Slice E4-02: Zone Bandwidth Proof

## Contract

One receiver observes exactly the nearest 32 of 128 moving entities while its
ephemeral downlink remains at or below 256 kbps and ephemeral projection creates
no durable vertices.

## Product seam

Add `publishTo(recipients, input)` as the unreliable-only selective operation on
the class-aware transport port established in E3-00. Every target must already
be E2-authorized; targeting cannot authorize a peer. The zone composes AOI
selection and delta encoding in the fabric workbench without a second filter.

AOI batches use `unreliable-unordered`; `@ts-drp/aoi` owns their generation,
batch, chunk, ordering and replay rules. Movement continues to use the existing
single `unreliable-sequenced` key per sender. The two-client proof therefore
remains within the zone's current one-key/two-sender sequenced budget and
requires `overLimit === 0`. This slice does not widen the E2 key or sender caps.

## TDD and acceptance

Run 128 simulated entities at 30 Hz for 20 seconds with 32 visible. Move the
observer across boundaries and require stable selection, leave within one
keyframe interval, and complete re-entry after loss.

Measure both exact routed payload bytes and the sibling raw peer connection's
selected candidate-pair byte delta. That candidate-pair `bytesReceived` delta,
including transport overhead, owns the ephemeral-downlink 256 kbps claim;
durable/libp2p traffic and routed payload bytes are reported separately and do
not satisfy or contaminate it.
If the pinned browser cannot expose a causal selected-pair counter, stop and
reslice rather than substituting payload accounting. Require zero durable
movement/AOI vertices.

Target: browser bandwidth case <2 minutes.

## Human surface

The workbench displays visible/total entities, bytes per second, keyframe wait,
raw link properties and durable vertex count. Run screenshot critique,
comparison with E4-00, and the non-blocking preview window.

## Must stay green

E3 loss/no-HOL, chat reconnect, durable `placeBlock`, and AOI properties.

## Feedback that changes this slice

Only measured packet size/cadence or AOI visibility behavior. This does not
authorize sharding, 40 browsers, physics or secrecy claims.
