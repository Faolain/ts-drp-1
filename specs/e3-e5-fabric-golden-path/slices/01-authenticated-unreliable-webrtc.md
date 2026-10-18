# Slice E3-01: Authenticated Unreliable WebRTC

## Contract

An already-authenticated libp2p WebRTC peer can negotiate one bounded sibling
raw channel whose ingress is attributed to that exact remote peer.

## API seam

Add a network-owned controller, preferably
`packages/network/src/unreliable-webrtc.ts`. Promote the reusable sanitized RTC
evidence extractor into `@ts-drp/network` and make `network-spike` consume it;
do not import `network-spike` into production or copy its browser oracle.
Give `NodeEphemeralAdapter` its existing reliable network plus a separate narrow
`DRPUnreliableWebRtcOwner`. The adapter constructor receives both explicitly.
`DRPNode` derives the raw owner only after its existing
`instanceof DefaultDRPNetworkNode` narrowing; an injected generic
`DRPNetworkNode` receives `null` and v3 raw sends fail closed. Controlled
fixtures pass a standards-shaped raw owner explicitly. This avoids widening the
shared `DRPNetworkNode` type and every unrelated mock:

```ts
interface UnreliableWebRtcRoute {
  readonly maxPayloadBytes: number;
  close(): void;
  onMessage(listener: (ingress: { bytes: Uint8Array; sender: string }) => void): () => void;
  send(peers: readonly string[], bytes: Uint8Array): Promise<boolean>;
  snapshot(): UnreliableWebRtcSnapshot;
}

openUnreliableWebRtcRoute(routeId: string): UnreliableWebRtcRoute;
```

The controller selects an existing open WebRTC `Connection`, opens the bounded
signaling protocol on that exact connection, and captures
`connection.remotePeer`. SDP/ICE does not carry application identity. The lower
peer ID initiates to prevent glare.

Create exactly one channel per sibling peer connection with
`ordered:false,maxRetransmits:0`. Require the receiver to observe those exact
properties and reject the reserved libp2p `"init"` label; the exact raw label is
`"ts-drp-ephemeral/1"`. Cap the node at eight sibling links, bound SDP bytes and
candidate count, use a ten-second setup deadline, multiplex route digests,
reject unknown routes before payload allocation, cap the complete routed
envelope at 1,200 bytes, expose only the remaining payload capacity after the
fixed routing header, fail if the negotiated SCTP maximum is smaller, and drop
above the `bufferedAmount` ceiling.

## TDD and acceptance

Use injected standards-shaped `RTCPeerConnection` fixtures for deterministic
offer, answer, ICE, glare, route, cap, backpressure, stale-generation,
disconnect, and cleanup cases. Retain a small real browser functional case in
E3-02; unit fixtures cannot prove the genuine transport.

Require no `connect`, `safeDial`, discovery, peer-selector, relay-policy, or
priority-admission call. A non-WebRTC or absent authenticated connection returns
`false`.

Target: focused unit/integration <45 seconds.

## Human surface

Expose a sanitized snapshot usable by the later workbench: active links,
channel properties, queued/backpressured drops, handshake failures, sent and
received counts. No UI is added yet.

## Must stay green

Network T1–T4 suites, lifecycle/restart, existing WebRTC dependency patch,
types/build, and no new dependency or lockfile change.

## Feedback that changes this slice

If a sibling peer connection cannot be bound causally to an authenticated
libp2p connection without private-field access, stop and reslice. Do not weaken
peer attribution.
