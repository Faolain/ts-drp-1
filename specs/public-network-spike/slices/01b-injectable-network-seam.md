# Phase 01b: Injectable DRP Network Seam

## Contract

`DRPNode` can use a caller-supplied implementation of the existing
`@ts-drp/types` network interface and a caller-supplied reconnect policy.
`DRPNetworkNode` can use a caller-supplied libp2p host factory while retaining
ownership of its production message queue and GossipSub data plane. Default
construction and fixed bootstrap/relay behavior remain unchanged.

## API seam

Refactor `DRPNode.networkNode` to the structural `DRPNetworkNode` interface from
`@ts-drp/types` and add explicit `DRPNodeDependencies`:
`networkNode?: DRPNetworkNode` and
`reconnect?: IDRPIntervalReconnectBootstrap | false`. When absent, construction
creates the current network and reconnect implementations exactly once.

Add `DRPNetworkNodeDependencies.hostFactory?: DRPNetworkHostFactory`. The
production class continues to own message-queue wiring, group-peer
notifications, subscriptions, scoring, and GossipSub handlers. The host factory
receives a production-owned core service builder and returns the libp2p host; it
cannot replace or reimplement those data-plane owners. Default host construction
is the current transport/discovery/service assembly.

If the current interface lacks a method already used by `DRPNode` (including
group-peer subscription), repair the authoritative interface rather than
casting the adapter or duplicating a narrower local interface.

`restart()` preserves the injected dependencies and rebuilds through the same
host factory; it may never silently construct the default host. The spike passes
`reconnect: false`; `ControlPlaneCoordinator` then owns typed health/recovery.

## Runnable artifact

A focused test constructs `DRPNode` with a deterministic fake network, starts
it, observes message/group subscriptions, and stops it without opening sockets.

## Verification

- Default construction still creates and starts the production network class.
- Injected construction never creates the production class or dials a default
  bootstrap.
- Host-factory injection reuses production-owned GossipSub/message-queue
  assembly and proves no second data-plane implementation exists.
- A shared network conformance suite runs the default and injected-host paths
  against identical message ordering/queue dispatch, subscription and
  group-peer events, send/broadcast semantics, scoring, start/stop/restart, and
  cleanup cases. Phase 07 cannot proceed if their data-plane traces differ.
- Start/stop/restart, message queue subscription, group-peer notifications,
  direct connect/send, and reconnect ownership are covered through the
  interface.
- No `as unknown as`, subclass private-state coupling, post-construction field
  replacement, or parallel network abstraction is allowed.
- Existing fixed-bootstrap grid and the every-phase gate pass.

## Must stay green

Production defaults, public exports, and all existing `DRPNode` callers.

## Feedback that changes this phase

If the public network interface cannot faithfully represent what `DRPNode`
already consumes, repair that owner before building the spike adapter.
