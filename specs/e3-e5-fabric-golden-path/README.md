# E3–E5 Fabric Golden Path

## Next Agent Prompt

Status: reconciled on 2026-08-24 from tracked-clean signed HEAD
`f6b3da881f9880444145a0617ae77e1c7bc88f2e`. Shared v3-room recovery,
two-client chat convergence, zone adoption, corrected E2 authority binding,
T1–T4 topology, the E3 transport track, deterministic AOI selection and
targeted AOI delivery are already shipped. Do not rebuild them.

This is a parallel product track, not the core durable-lifecycle spine. First
retain the signed T4 result and record the current two-client chat/zone baseline:
create/join, durable message or `placeBlock`, E1 movement, disconnect/reconnect,
and durable convergence. Then E3/E4 may proceed alongside Phase 3f–3h. E5 waits
for the stable durable-command and authority boundaries established by Phase 3.

The next product slice is
[Slice E4-03](slices/05-loss-tolerant-deltas.md). Land its tests-only RED and
GREEN separately. E4-01 (`f57afdd3`) shipped deterministic AOI selection and a
bounded fixed batch. E4-02 (`55d8eecf`) shipped authorized targeted delivery.
Those signed implementation labels are prerequisites, not evidence that the
older active-spec slices 05 and 06 are complete. E4-03 adds loss-tolerant
projection; E4-04 then runs the original 128-entity browser bandwidth proof.

Warnings:

- The installed libp2p WebRTC muxer privately owns its `RTCPeerConnection` and
  creates reliable data channels. Do not reach through its private fields or
  expand the existing dependency patch.
- E3 transport does not authorize a peer. Existing E2 anchor, ACL, epoch,
  peer-to-author, writer, replay, and receive-budget checks remain the sole
  authority.
- After E3-02, a v3-authorized unreliable class must not silently use GossipSub
  or a reliable libp2p stream. A missing or backpressured raw route returns
  `false` and is visible in telemetry. The pre-existing public legacy
  `DRPNode.openEphemeral` mode remains on its reliable carrier and is not E3
  evidence.
- Do not claim packet-loss performance unless Chromium's peer-to-peer loss
  control passes the 100%-loss causal calibration in E3-03.
- E5's referee arm is blocked on a separately justified ACL-role successor.
  Do not alias `admin` or `finality` to `referee`.

Global checklist:

- [x] [E3-00](slices/00-independent-delivery-lanes.md): split reliable and
      unreliable drains.
- [x] [E3-01](slices/01-authenticated-unreliable-webrtc.md): add the bounded
      authenticated raw WebRTC owner.
- [x] [E3-02](slices/02-zone-transport-adoption.md): route zone movement over
      raw WebRTC while preserving E2.
- [x] [E3-03](slices/03-loss-and-hol-proof.md): prove the 30% loss/no-HOL claim.
- [x] [E4-00](slices/04-deterministic-aoi.md): ship deterministic AOI selection,
      its bounded fixed batch and authorized targeted delivery prerequisites.
- [ ] [E4-03](slices/05-loss-tolerant-deltas.md): ship bounded loss-tolerant
      keyframes/deltas in the existing AOI owner.
- [ ] [E4-04](slices/06-zone-bandwidth-proof.md): prove 32 visible entities at
      no more than 256 kbps down.
- [ ] [E5-00](slices/07-cosigned-intent.md): define canonical co-signed intent.
- [ ] [E5-01](slices/08-prejournal-commit-admission.md): enforce it before local
      issuance and remote journal admission.
- [ ] [E5-02](slices/09-referee-arm.md): add referee decisions only after a
      separately authorized ACL-role transition.

Before ending any implementation pass, update this section with the exact
signed HEAD, completed gates and timings, unresolved findings, and next pickup
point.

## Goal

Complete the game-specific plane on the already-shipped shared durable room:

1. genuinely unreliable, authority-bound ephemeral traffic;
2. deterministic interest management and loss-tolerant entity projection; and
3. durable co-signed outcomes and, later, genuine referee decisions.

The first playable end state is two real browser clients in one v3 zone. They
exchange movement over an unordered, zero-retransmit data channel; retain
durable `placeBlock`; reconnect through the existing room path; and converge on
the same durable state. E4 reduces the receiver's visible set and bandwidth.
E5 makes a two-party outcome durable exactly once.

## Current foundation

- `examples/v3-room` owns trust, invite, recovery, issuance, projection,
  ingress, and reconnect composition.
- `examples/grid/src/v3-zone.ts` already adopts that owner, publishes movement
  as `unreliable-sequenced`, sends targeted fixed AOI batches as
  `unreliable-unordered`, and retains `placeBlock` as a durable command.
- `@ts-drp/ephemeral` owns delivery classes, canonical frames, latest sequence
  watermarks, E2 authority comparison, replay rejection, bounded receive work,
  deterministic AOI selection and the fixed AOI batch codec.
- `@ts-drp/network` and `NodeEphemeralAdapter` own authenticated raw WebRTC,
  independent reliable/raw drains, lane selection and targeted routing.
- The remaining E4 defect is projection recovery: the zone replaces its visible
  population from each decoded fixed batch, so a lost batch has no generation,
  base-keyframe, atomic assembly or bounded wait-for-keyframe semantics.
- T1–T4 already bound libp2p connection admission, selection, and relay
  preference. E3 must not introduce a raw peer dial or second topology owner.

## End-state ownership

| Concept                                                                 | Sole owner                                  |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| Delivery class, queues, E2 frame, replay, receive budgets               | `@ts-drp/ephemeral`                         |
| Raw WebRTC signaling, peer link, data channel, routing and backpressure | `@ts-drp/network`                           |
| Reliable/raw lane selection plus E2 peer-author projection              | `NodeEphemeralAdapter`                      |
| Durable room authority and reconnect                                    | `examples/v3-room` + existing v3-live owner |
| Deterministic AOI, fixed batch and loss-tolerant projection             | `@ts-drp/ephemeral`                         |
| Canonical co-signed intent/proof                                        | new `@ts-drp/outcome-commit`                |
| Product composition and workbench                                       | `examples/grid`                             |

No slice creates a second authorization oracle. Network supplies authenticated
peer attribution and bytes; E2 decides whether those bytes may affect the
ephemeral channel. Durable commit admission remains on the v3 issuance/ingress
path, never in the network or renderer.

## Slice graph

```text
E3-00 split drains
   -> E3-01 raw authenticated WebRTC
      -> E3-02 zone adoption
         -> E3-03 real loss/no-HOL proof
            -> E4-00 deterministic AOI + targeted-delivery prerequisites
               -> E4-03 resilient projection
                  -> E4-04 bandwidth/browser proof
                     -> E5-00 co-signed intent
                        -> E5-01 pre-journal admission
                           -> E5-02 genuine referee arm
```

Every slice answers one question and leaves a permanent API seam. The only
transitional behavior is that, after E3-00 and before E3-02, the production node
adapter still sends both class-aware calls through its existing reliable
carrier. E3-02 removes that behavior; it must not survive the E3 milestone.

This graph is the order inside the E product track, not the repository's global
critical path. The durable spine remains:

```text
two-client preservation baseline
   -> Phase 3f bounded frontier/tip aggregation and batching
   -> Phase 3g rebase outbox
   -> Phase 3h reversible signed migration rehearsal
   -> Phase 3 exit gate
   -> Phase 4a-4d fail-closed adapter, snapshots and shadow comparison
   -> Phase 5 certified sealing
   -> Phase 6 verified adoption and pruning
   -> Phase 7 archive and age-independent cold join
```

Golden-path recovery accompanies every boundary; it is never an alternative to
the boundary. E3 and its dependent E4 work may run as one product track in
parallel with the Phase 3 spine after the baseline. E5 consumes the completed
Phase 3 authority boundary. S1 may begin after Phase 3 authority; later S slices
wait for the certified/archive evidence they require.

| Durable boundary | Added two-client preservation claim                                       |
| ---------------- | ------------------------------------------------------------------------- |
| T4 baseline      | Chat and zone still communicate and converge through bounded topology.    |
| Phase 3f         | Concurrent writers retain bounded dependencies.                           |
| Phase 3g         | Offline/reconnecting authors cross epoch cuts without duplicate commands. |
| Phase 3h         | Migration rehearsal is reversible and does not activate the new plane.    |
| Phase 4          | Live clients converge while independently computed snapshots agree.       |
| Phase 5          | Clients agree on the same certified epoch close.                          |
| Phase 6          | Clients recover after verified adoption and pruning.                      |
| Phase 7          | A new client cold-joins an old archived room without full history.        |

## Research basis

- The WebRTC specification defines `RTCDataChannelInit.ordered` and
  `maxRetransmits`; `ordered:false, maxRetransmits:0` must be selected at channel
  creation and cannot be inferred from application delivery.
  <https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit-maxretransmits>
- The libp2p WebRTC direct specification binds remote identity after its
  authenticated handshake. E3 uses an already-authenticated libp2p WebRTC
  connection for signaling and peer attribution; SDP does not become identity.
  <https://github.com/libp2p/specs/blob/master/webrtc/webrtc-direct.md>
- Chromium DevTools' Network domain exposes peer-to-peer packet loss, queue and
  reordering controls. The gate capability-checks the pinned browser and proves
  the control affects the data channel before recording performance.
  <https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditions>

## Architecture decisions

### One class-aware transport port

`EphemeralTransportPort` is the one class-aware transport seam:

```ts
interface EphemeralTransportSendInput {
	readonly bytes: Uint8Array;
	readonly class: EphemeralDeliveryClass;
	readonly recipients: "all" | readonly string[];
}

interface EphemeralTransportPort {
	// Changed members only; existing peer, authority, ingress and close members remain.
	maxEnvelopeBytes(deliveryClass: EphemeralDeliveryClass): number;
	send(input: EphemeralTransportSendInput): Promise<boolean>;
}
```

`@ts-drp/ephemeral` validates the exact per-class cap before queueing, retains
two drains under one combined capacity, and verifies every selective recipient
against the current E2 authority before send. The existing reliable cap remains
65,536 bytes. For v3 raw classes, the network route owns the 1,200-byte complete
routed-envelope limit and exposes the smaller remaining payload capacity after
its version and route-digest header; `maxEnvelopeBytes` returns that capacity
rather than restating 1,200. `publish()` sends to `"all"`; the later
`publishTo()` uses the same port and is available only to unreliable classes.
`NodeEphemeralAdapter` is the only production lane selector. An optional nested
transport was rejected because it would create a parallel lifecycle and
long-lived compatibility path.

### One bounded sibling raw link

`@ts-drp/network` owns one sibling `RTCPeerConnection` per authenticated remote
peer, lazily negotiated over a stream on an already-open libp2p WebRTC
connection. It never dials a new libp2p peer. The node-wide cap is eight raw
links until a later measurement justifies accounting them directly in T1.

One data channel is created with a label explicitly distinct from the reserved
libp2p `"init"` channel:

```ts
pc.createDataChannel("ts-drp-ephemeral/1", {
	ordered: false,
	maxRetransmits: 0,
});
```

Room routes are multiplexed inside that channel with a fixed version and
32-byte route digest. The complete routed envelope is at most 1,200 bytes. The
controller exposes the remaining payload capacity after its fixed routing
header and fails closed if the negotiated SCTP maximum is smaller. E2's existing
authority frame remains inside that payload.

### No silent reliable fallback

After E3-02, v3-authorized unreliable classes either use the genuine raw channel
or return `false`. Silent reliable fallback would make the browser artifact
green while failing the product claim. Reliable delivery remains explicitly
available as `reliable-unordered`. The legacy `DRPNode.openEphemeral` overload
has no E2 authority carrier, remains reliable-only, cannot open or receive the
raw route, and is excluded from E3 claims; preserving that existing public API
is not a fallback in the v3 path.

### Receiver-observed performance

`RTCDataChannel.send()` proves only local enqueue. E3-03 records receiver
sequence and timestamps, age of information, p95, and maximum inter-arrival
gap. It first calibrates one-sided sender loss at 100% for 500 ms while both the
raw and libp2p peer connections stay open, then measures 30% loss after the
channels are established. Every measured trial must contain a receiver-observed
sequence gap followed by a later received sequence. Both pages run in the same
pinned Chromium process and use `Date.now()`; the harness requires their sampled
clock skew to be at most 5 ms before each trial. Missing reliable samples count
as stale until the deadline rather than disappearing from the percentile as
survivor bias. Application-level dropping cannot satisfy E3.

## Verification and runtime budget

| Lane                                   |      Target |
| -------------------------------------- | ----------: |
| E3-00 focused + E1/E2 preservation     | <30 seconds |
| E3 network controller unit/integration | <45 seconds |
| Two-client raw zone                    |  <4 minutes |
| Chromium loss/no-HOL campaign          |  <3 minutes |
| E4 unit/property                       | <20 seconds |
| E4 browser bandwidth                   |  <2 minutes |
| E5 unit/admission                      | <45 seconds |
| E5 two-client durable browser          |  <2 minutes |
| Completed ordinary affected lane       | <10 minutes |

The existing chat reconnect, zone durable command, zero-durable-movement, E2,
T1–T4, typecheck, build, lint, formatting, and package gates remain green. WAN,
long topology, and large-client campaigns are release evidence, not ordinary
developer gates.

## Visual review rule

The fabric workbench is a first-class product artifact, not test-only markup.
For every accepted visual change:

1. capture the relevant two-client view;
2. run an unprimed `screenshot-critique` as the last visual check;
3. when a prior accepted view exists, run `compare-screenshots` against it;
4. open the shots with `preview-shots` for a non-blocking five-minute human
   window; if no response arrives, record the evidence-based decision, close
   the Preview window, and proceed.

## Scope firewall

- No protocol-v3 registry, anchor, ACL, signature, finality, or journal changes
  in E3 or E4.
- No public-anchor-derived MAC or group key.
- No private libp2p muxer/peer-connection access and no new dependency patch.
- No raw implicit dial, second selector, discovery owner, relay policy, or T1–T4
  capacity bypass.
- No unreliable traffic may create a durable vertex.
- No application-level loss shim may earn the E3 performance claim.
- No AOI secrecy, authoritative physics, prediction, sharding, or 1,000-client
  claim.
- No cross-object trade, saga, or conservation claim in the first E5 slice.
- No reuse of `admin` or `finality` as a referee role.
- No freeze-governance amendment unless implementation exposes a concrete new
  provenance defect.

## Known risks and stop conditions

- A sibling peer connection consumes ICE/DTLS/SCTP resources outside today's
  T1 accounting. Keep the cap at eight, expose it in sanitized telemetry, and
  stop before a scale claim that needs more.
- Local host candidates prove the product path, not cross-NAT reachability.
- SCTP can still share congestion. Keep raw envelopes at or below 1,200 bytes
  and prove freshness from the receiver.
- Chromium loss controls are experimental. If the pinned browser lacks them or
  a 100%-loss calibration still delivers data, stop and reslice the loss harness
  rather than substituting application drops.
- Missing deltas must not partially mutate AOI state; recovery waits for a
  bounded keyframe.
- The current ACL has only `admin`, `finality`, and `writer`. E5-02 remains
  blocked until a genuine referee role is justified and governed.

## Draft synthesis record

Three independent drafts were requested. Two completed and independently found
the same application-level HOL defect, raw sibling-peer-connection need, E2
authority boundary, and E3-first ordering. The third exceeded its bounded
window and remained NO_VERDICT after a stop-and-summarize request. Direct source
inspection resolved the remaining choices above. No reviewer timeout was
treated as approval or as a blocker.
