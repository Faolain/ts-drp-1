# Phase 07: Disconnected-Joiner Grid Demonstration

## Contract

A joiner that knows an opaque namespace and grid object ID—but no DRP Peer
ID—discovers a valid participant, joins GossipSub, synchronizes/mutates the
grid, establishes direct WebRTC, and recovers or terminates cleanly when its
selected relay disappears.

## API seam

`ControlPlaneCoordinator` composes the Phase 01b injectable `DRPNode` and
`DRPNetworkNode` seams with `RendezvousDirectory` and `RelayPolicy`. A
spike-local `ControlPlaneHostFactory` makes bootstrap, routing candidate source,
relay reservation, address policy, and host construction explicit while reusing
the production-owned message queue and GossipSub service builder. The existing
GossipSub/object data plane is not reimplemented, and production defaults are
unchanged. The injected `DRPNode` sets `reconnect: false`; the coordinator owns
typed control-plane health.

## Runnable artifact

The two-page `/grid` example exposes milestone state:
reservation/fallback, valid DRP peer, mesh, synchronized object, direct WebRTC,
mutation bytes, and relay-loss recovery.

## Verification

1. Both peers pass `bootstrap_peers: []`; omission is a test failure. Block and
   assert zero dials to default Topology seeds and zero fixed-bootstrap/PX
   introductions. Host-config snapshot tests require no `@libp2p/bootstrap`, no
   default Topology multiaddrs, no cold-start `pubsubPeerDiscovery`, and GossipSub
   `doPX: false` until the first rendezvous-authenticated connection. The real
   connection gater delegates every outbound multiaddr to `AddressPolicy`;
   production's open `denyDialMultiaddr` is forbidden. Typed control-plane health
   cannot reintroduce seeds mid-run.
2. Owned relay intentionally unavailable.
3. Required browser-creator/browser-joiner case: creator registers a valid
   short-TTL record in the signed registry. Also run a labeled Node-creator
   DHT-anchor case; the anchor may advertise only that Node.
   Before opening the joiner page, wait for the creator's validated signed relay
   address/reservation event, preserving the readiness protocol in
   `docs/cross-browser-testing.md`; fixed delays and page-loading state cannot
   satisfy readiness.
4. Joiner starts without creator Peer ID. Its provenance trace must be exactly
   `rendezvous register → discover → validate → routing-backed relay candidate
   → reservation → dial`; any fixed-bootstrap or PubSub-PX discovery fails.
   The dial gater also blocks the known default Topology hostnames/Peer IDs as an
   independent anti-cheat assertion, and the event sink fails on any pre-auth PX
   candidate even if it loses a race.
5. Success scenario requires reservation acceptance, creator dial, mesh join,
   object synchronization, and bidirectional grid movement convergence.
6. Exhaustion is a separate scenario: it must initiate owned fallback within
   5 s and reach a typed terminal/fallback result; it is never counted as a
   WebRTC success.
7. Direct proof correlates the selected libp2p connection with its
   `RTCPeerConnection`, requires a non-`/p2p-circuit` WebRTC remote address or
   transport tag, requires selected local and remote ICE candidate types other
   than `relay`, an open data channel, and increasing direct bytes in both
   directions. Relayed and direct byte counters are emitted separately.
8. Removing the selected relay produces bounded replacement/recovery after the
   direct connection, without silently dialing a fixed seed.
9. Chromium, Firefox, and WebKit run five deterministic repetitions of the
   dedicated success scenario and five repetitions of the exhaustion scenario.
10. The Phase 09 opt-in public canary runs the same milestone/provenance oracle
    once per browser and real network condition; it is evidence, not CI.
11. Capture full/cropped screenshots and run screenshot-critique.
12. Run the every-phase review and quality gate.

## Must stay green

Existing `examples/grid` fixed-relay tests and all production packages.

## Feedback that changes this phase

If direct-byte instrumentation cannot correlate libp2p and RTC connections, the
demonstration cannot pass. Browser-only recovery with no registry/DRP-operated
service is a separately labeled no-go unless measured evidence proves it.
