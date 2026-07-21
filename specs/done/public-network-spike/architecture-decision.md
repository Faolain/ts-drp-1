# Architecture Decision: Split DRP Control Plane

Status: **accepted architecture shape; public production enablement deferred**

## Decision

Keep the existing GossipSub, object synchronization, and direct-upgrade data
plane. Introduce independently configurable routing, rendezvous, and relay
owners in a future production change.

Routing is runtime-specific:

- Node uses client-mode Amino DHT for peer lookup, closest-peer queries, and
  publication.
- Browser uses bounded delegated Routing V1 endpoints for lookup only.

Rendezvous uses signed, expiring DRP records replicated to independently
configured registries. The default scope is an opaque, versioned per-network
namespace. Per-object namespaces are permitted only when a product requires
room isolation and accepts the added publication and privacy lifecycle.
Discovery results remain untrusted until record validation, address policy, and
application authorization all pass.

Configured Node-owned DHT anchors are an optional secondary path. They advertise
only their owning Node and cannot represent browser membership.

Public relay discovery may feed the bounded relay policy, but public
reservations are experimental overflow only. Any migrated supported path must
provision at least two owned DNSADDR seeds/relays under independently reviewed
failure domains. The current two fixed seeds preserve the legacy capability but
do not prove failure-domain independence. Public routers and relays are
best-effort utilities with no DRP availability SLA.

No production public path is enabled by this decision. That requires a complete
authorized campaign satisfying the pre-registered evidence rules in
`packages/network-spike/src/contract.ts`.

## Alternatives

| Alternative                                  | Decision                                      | Reason                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node publisher plus browser delegated lookup | Select                                        | It matches runtime capabilities without putting Node DHT/TCP code in browser bundles. Publication and lookup stay visibly separate.                                                                                                                                              |
| Browser full-DHT participation               | Reject for the tested outbound-only host      | The protocol exchange completed, but the browser had no dialable address and an independent observer found no provider. A future materially different listener/transport may reopen the question.                                                                                |
| Custom signed DRP registry                   | Select as the first rendezvous implementation | It supports browser publication, bounded freshness, replay protection, admission, multiple endpoints, and explicit operational ownership. It does not confer authorization.                                                                                                      |
| libp2p Rendezvous implementation or sidecar  | Defer                                         | Issue #5's dated research found no maintained official JavaScript implementation and described the specification as a working draft. Recheck that ecosystem state before implementation; a sidecar still would not remove DRP's admission, abuse, privacy, or operations burden. |
| DHT anchor                                   | Retain as a narrower Node-only option         | It is useful for locating configured DRP Nodes, but adds a dependency chain and cannot publish a browser identity.                                                                                                                                                               |
| Delegated closest-peer relay discovery       | Retain as an experimental candidate source    | Deterministic evidence proves bounded qualification and reservation handling; public success and diversity remain unmeasured.                                                                                                                                                    |
| Owned DNSADDR fallback                       | Require                                       | DRP controls its capacity and SLO. Public utility observations cannot create an availability guarantee.                                                                                                                                                                          |

## Product decisions

| Question                                                     | Decision                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can browsers recover with every DRP-operated service absent? | No. The selected design requires at least one DRP-operated registry, configured Node anchor, or owned seed. A zero-service requirement needs a different browser membership publisher and a new security review.                                                                                                        |
| What is the discovery scope?                                 | Opaque per-network namespace by default. Object/room scope is opt-in when isolation justifies the added lifecycle. Global enumerable membership is rejected.                                                                                                                                                            |
| What admission model is used?                                | Invite token is the safe proof-of-concept default; allowlist is appropriate for closed deployments. Open admission is a Sybil-unsafe canary. Proof-of-work is defense in depth only, not identity or authorization.                                                                                                     |
| Which delegated endpoints are permitted?                     | None are authorized by this record. The production default is an empty allowlist; adding an endpoint requires named operator approval, privacy/terms review, multiple-endpoint failover, and no credential-bearing URL. Self-hosted Routing V1 is deferred until endpoint governance or availability requires it.       |
| Which browsers and transports are in scope?                  | Chromium, Firefox, and WebKit. WSS is the conservative browser profile; WebTransport and WebRTC Direct remain an explicitly broader profile until public evidence supports policy changes.                                                                                                                              |
| How many reservations are required?                          | The policy must be capable of two concurrent reservations across at least two coarse operator groups for a supported public baseline. Coarse IP and ASN group counts are mandatory evidence but have no separate pass threshold; operator independence is the frozen gate. Current public evidence does not satisfy it. |
| Are public relays baseline or overflow?                      | Overflow only, and even that remains disabled in production until the public overflow rule passes. Owned relays are the supported fallback.                                                                                                                                                                             |
| Does proof-of-work become the default?                       | No. It increases per-registration cost but does not prevent Sybil identities, botnets, or challenge-capacity pressure.                                                                                                                                                                                                  |
| Is self-hosted Someguy required now?                         | No. Preserve a configurable Routing V1 seam and revisit when endpoint policy, privacy, or SLO requirements demand an owned service.                                                                                                                                                                                     |
| What cold-start/recovery SLO applies?                        | The controlled/owned path requires mesh and first sync within 30 s, direct upgrade within 20 s, recovery within 60 s, and a total-outage diagnostic within 30 s. Public features have no SLA; their eligibility gates are the pre-registered observed-rate/latency rules and remain unsatisfied.                        |

## Consequences

The design has more explicit components than a bootstrap-address substitution,
but each component has one security and lifecycle owner. Browser limitations
stay visible instead of being hidden by a universal configuration. DRP assumes
operational responsibility for rendezvous and owned fallback, while optional
public capacity remains independently disableable.

The current production reconnect loop and permissive default dial gate do not
yet satisfy this architecture. Their replacement is design work described in
the [production plan](production-plan.md), not a claim about the shipped
production runtime.

## Evidence

- Browser full-DHT rejection:
  [review](reviews/phase-03b.md) and
  `packages/network-spike/tests/browser-dht.test.ts`.
- Runtime-specific routing:
  [Node review](reviews/phase-02.md),
  [browser review](reviews/phase-03.md), and the corresponding routing tests.
- Signed rendezvous and anchor comparison:
  [record review](reviews/phase-04.md),
  [registry/anchor review](reviews/phase-05.md), and registry tests.
- Relay lifecycle:
  [relay review](reviews/phase-06.md) and relay tests.
- End-to-end data-plane preservation:
  [grid review](reviews/phase-07.md) and grid browser tests.
- Bounded hostile behavior:
  [failure review](reviews/phase-08.md) and failure-campaign tests.
- Public decision boundary:
  [blocked report](evidence/phase-09-environment-blocked.json) and
  [campaign review](reviews/phase-09.md).
