# Unshipped Production Follow-Up Plan

This required issue deliverable describes future work; none of its
`control_plane` configuration or typed-health model is shipped. It promotes the
proven ownership boundaries, not the spike package itself. Issue #5 permits a
greenfield direct replacement, but that is not evidence that replacement is
safe: every existing `DRPNetworkNodeConfig` consumer must move in one reviewed
change. Fixed bootstrap and owned-relay capability must still remain available
as a supported policy.

## Configuration ownership

Refactor `DRPNetworkNodeConfig` around a `control_plane` section with distinct
typed owners:

- `routing`: runtime-specific Node DHT and browser Routing V1 sources, endpoint
  policy, caches, and bounded lookup settings;
- `rendezvous`: signed-registry endpoints, namespace scope, admission client,
  freshness, and optional configured Node anchors;
- `relay_policy`: candidate sources, reservation targets, diversity and
  lifecycle bounds, plus owned DNSADDR fallback;
- `address_policy`: the one outbound address and dial-time DNS decision owner;
- `observability`: a typed event sink and retention/redaction policy.

Keep optional local relay-service capacity separate from relay-client policy.
A peer may consume relays without operating one, and operating a relay must not
silently change routing or rendezvous.

Do not add compatibility aliases or parallel retry/address abstractions. Reuse
or promote the authoritative owner after production requirements are fixed.
The relevant proof seams are `DRPNetworkHostFactory`,
`DRPNetworkHostPolicy`, `AddressPolicy`, `NodeRouting`, `BrowserRouting`,
`RendezvousDirectory`, and `RelayPolicy`.

## Typed control-plane health

Replace reconnect logic based on exact bootstrap Peer IDs with a typed status
model:

- routing readiness and endpoint degradation;
- rendezvous freshness and replica availability;
- relay reservation health and owned-fallback state;
- authenticated DRP peer presence;
- mesh and object synchronization state;
- recovery attempt, deadline, terminal reason, and cleanup state.

One coordinator consumes those signals and chooses bounded recovery. A healthy
authenticated DRP peer or synchronized mesh can remain healthy even if a
particular seed disconnects. Conversely, a connected seed does not prove
rendezvous, reservation, or data-plane health.

This is a design-only production deliverable. The spike
`ControlPlaneCoordinator` proves an ordered grid control flow and relay
replacement, while `FailureControlPlaneHealthAdapter` proves a small typed
health vocabulary. Neither implements the complete status model above.
Production `DRPIntervalReconnectBootstrap` still checks exact configured
bootstrap Peer IDs and reconnects to those addresses.

## Observability contract

Promote a sanitized typed vocabulary rather than exposing libp2p internals or
free-form strings. It must cover routing attempts/results, address-family
admission, dial outcomes, validated rendezvous freshness, endpoint
backoff/rate-limit state, reservation lifecycle, fallback, first authenticated
peer, mesh/object readiness, direct versus relayed traffic, recovery, terminal
reason, and cleanup.

Raw Peer IDs, addresses, namespaces, tokens, and endpoint credentials belong
only in access-controlled short-retention diagnostics. Metrics use bounded
labels and aggregate operator diversity; logs must not create stable identity
correlation.

## Delivery sequence

1. **Resolve product and operator policy.** Choose namespace scope, admission
   lifecycle, registry operators, permitted Routing V1 endpoints, owned
   fallback domains, browser/transport support, privacy notice, and retention.
2. **Run the authorized campaign.** Add the environment-specific executor on a
   separately reviewed ref, supply two independent registries and two real
   egress conditions, and evaluate the frozen rules. Do not weaken thresholds
   after observing results.
3. **Land configuration and status types.** Change the authoritative
   `DRPNetworkNodeConfig` and reconnect interface; avoid an adapter layer that
   leaves the old combined “bootstrap” meaning alive.
4. **Adopt the single address owner.** Make production host construction use
   the same policy for routing, rendezvous, relay, DNSADDR, and direct dials.
   Remove the allow-all default for the new control-plane mode.
5. **Integrate runtime routing.** Keep Node-only DHT dependencies out of browser
   entry points. Browser publication remains structurally unavailable.
6. **Deploy signed rendezvous.** Start with invite or allowlist admission,
   independent endpoints, short TTLs, bounded reconciliation, and explicit
   operator telemetry. Add Node anchors only as a separately selectable path.
7. **Integrate relay overflow and owned fallback.** Public candidate sources
   stay disabled unless their public evidence passes. Owned DNSADDR relays
   remain the supported path.
8. **Replace reconnect ownership.** Drive recovery from typed status and one
   parent deadline. Preserve typed terminals and cleanup under partitions,
   hostile inputs, and total outage.
9. **Roll out by policy.** Begin with owned routing/rendezvous/relay, then
   canary delegated lookup and optional public overflow independently. Each
   component has a kill switch and cannot disable owned fallback.

## Required release gates

- The fixed bootstrap/owned-relay path and the new path pass the same production
  data-plane conformance suite.
- Chromium, Firefox, and WebKit pass disconnected-joiner, direct-upgrade,
  relay-loss, and fallback scenarios.
- Node-only dependencies are absent from browser bundles.
- Every network loop has a deadline, cap, abort, terminal, cleanup, and typed
  telemetry assertion.
- Security and privacy owners approve endpoint policy, admission, retention,
  and incident response.
- Public features remain disabled when campaign coverage is partial, blocked,
  incomparable, rate-limited, or operator diversity is insufficient.

Self-hosted Routing V1 and a Rendezvous sidecar are deployment options, not
prerequisites. Reconsider them only when owned endpoint policy or an explicit
availability requirement justifies their additional operational surface.
