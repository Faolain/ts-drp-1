# Public Routing, Rendezvous, and Relay Decision Record

Issue: [Faolain/ts-drp-1#5](https://github.com/Faolain/ts-drp-1/issues/5)

## Outcome

The investigation validates a split control-plane architecture while rejecting
public IPFS utilities as a production dependency on the evidence currently
available.

The selected shape keeps the DRP GossipSub/object data plane unchanged and
separates three owners:

- runtime-specific peer routing;
- authenticated DRP rendezvous;
- bounded relay selection with an owned fallback.

Node may publish and query through client-mode Amino DHT. Browsers may query
through delegated Routing V1 but cannot publish membership through that
adapter. Signed, short-lived DRP records are therefore the preferred browser
rendezvous mechanism. Node-owned DHT anchors remain a narrower optional path.
Public relay candidates remain experimental overflow only. They provide no
availability SLA and cannot replace owned DNSADDR seeds/relays.

This record closes the local investigation; it does not authorize a production
migration or claim that issue #5's public-measurement criterion is complete.
The public campaign is deliberately
`environment-blocked`: operator consent, two independently operated registries,
and a second materially distinct authorized egress were not supplied. Its
durable report records zero public requests and leaves all public-rate criteria
unsatisfied. See the [architecture decision](architecture-decision.md) and
[acceptance audit](acceptance-audit.md) for the exact boundary.

## Why the boundary exists

Routing, membership, and reachability answer different questions. A routing
result can locate a Peer ID or provider, but it cannot establish that the peer
belongs to DRP, is authorized for an object, or will accept a relay
reservation. Treating those facts as interchangeable would turn untrusted
network metadata into authority.

Browser and Node peers also have materially different capabilities. The tested
outbound-only browser DHT can exchange provider protocol messages but has no
dialable address to publish, while delegated browser routing is lookup-only.
The rendezvous layer therefore cannot be hidden inside a shared “bootstrap”
list without recreating the assumptions this investigation set out to remove.

Finally, public utilities are operated outside DRP's control. Even a favorable
sample would be an observed rate, not an SLA. The absent authorized campaign
means there is currently no evidence for cold-start reliability, public relay
availability, operator diversity, or public direct-upgrade rates. Owned
fallback remains part of the architecture rather than a temporary migration
crutch.

## Principles and invariants

- A discovered address is an untrusted dial candidate, never authorization.
- Rendezvous records prove key control and bounded freshness, not DRP or object
  membership.
- Browser publication is unavailable through delegated Routing V1; no helper
  may advertise a browser as a DHT provider.
- In the selected control-plane mode, GossipSub discovery expands an
  authenticated connection rather than acting as initial rendezvous.
  Production still uses cold-start PubSub discovery until a separate migration.
- HOP advertisement is not reservation acceptance. Only a decoded accepted
  reservation with a live expiry counts; resource limits are retained when the
  relay supplies them.
- Public routers and relays are opt-in, best-effort, and outside the production
  critical path until pre-registered public evidence passes.
- Every endpoint attempt is bounded, and multi-attempt network operations
  accept caller cancellation. Composed flows such as relay acquisition and
  total outage own a parent deadline that child retries cannot reset.
- The selected production design requires one address policy to own outbound
  dialability decisions, including dial-time DNS rechecks. The current
  production default remains allow-all when no policy is injected, so adopting
  that owner is a migration gate rather than a shipped claim.
- Raw identities, addresses, namespaces, and credentials never enter durable
  evidence. Any future public executor must derive pseudonyms with a secret
  per-run salt; schema validation alone cannot prove cross-run unlinkability.
- The fixed bootstrap and owned-relay capability remains runnable even after a
  future control-plane migration.
- Production reconnect health must describe typed control-plane state rather
  than connectivity to particular seed Peer IDs.

## Decisions and follow-up

The canonical decisions, alternatives, and deferrals live in the
[architecture decision](architecture-decision.md). The
[security and privacy analysis](security-privacy.md) owns the threat boundaries.
The required [production follow-up plan](production-plan.md) records the
configuration, observability, reconnect, and rollout prerequisites for any
separate production change without promoting spike code by copying it. The
[acceptance audit](acceptance-audit.md) maps every issue
deliverable, decision question, failure injection, telemetry requirement, and
go/no-go threshold to current evidence.

## Code map

The code is the source of truth for mechanics:

- `packages/network-spike/src/contract.ts` owns the pre-registered evidence
  rules and interpretations.
- `packages/network-spike/src/probe/` owns bounded execution, telemetry, and
  address classification.
- `packages/network-spike/src/node-routing/` and
  `packages/network-spike/src/browser-routing/` own runtime-specific routing.
- `packages/network-spike/src/record/` and
  `packages/network-spike/src/registry/` own signed rendezvous and admission.
- `packages/network-spike/src/relay/` owns relay qualification, reservations,
  diversity, lifecycle, and fallback.
- `packages/network-spike/src/grid/` owns the disconnected-joiner proof while
  reusing the production data plane.
- `packages/network-spike/src/failure-campaign/` owns deterministic hostile
  scenarios.
- `packages/network-spike/src/public-campaign/` owns the fail-closed public
  campaign. `packages/network-spike/src/campaign-plan.ts` freezes its work
  before consent.
- `packages/network/src/node.ts` owns the production host and its injectable
  host-policy seam. `packages/node/src/index.ts` owns network/reconnect
  dependency injection.

The matching tests live under `packages/network-spike/tests/` and
`examples/network-spike/e2e/`. Historical reviewer findings and their
dispositions remain in [reviews](reviews/).

## Dead ends and discoveries

- A full DHT in an outbound-only browser is not a general membership publisher.
  Protocol success without a dialable provider record produced a false-looking
  success until an independent observer was added.
- A DHT anchor cannot publish on behalf of a browser. It can advertise only the
  Node that owns the provider record, so it is an anchor path, not browser
  membership.
- Issue #5's dated research found no maintained official JavaScript Rendezvous
  package and described the specification as a working draft. This record does
  not assume that ecosystem finding remains current: any implementation must
  recheck it. A sidecar would still leave admission, spam resistance, privacy,
  and operations as DRP responsibilities.
- Open registration and proof-of-work do not solve Sybil membership. Open mode
  is useful only as an abuse canary; proof-of-work can raise cost but cannot
  establish identity or authorization.
- HOP protocol discovery produced misleading “relay available” conclusions
  until the policy decoded the reservation response and tracked expiry,
  replacement, and resource limits.
- Public testing could not be made honest by simulating a second egress or
  inventing operator diversity. The correct artifact is a blocked report with
  no synthetic observations.

## Evidence and visual provenance

The committed [blocked public report](evidence/phase-09-environment-blocked.json)
is the authoritative public-execution result. It is intentionally negative
evidence: zero requests, zero observations, and explicit missing authorization.
The review ledger records the deterministic harness, browser, security, and
failure-campaign gates that support the non-public decisions.

There was no supplied baseline, mood board, or reference application to match.
Visual acceptance was based on correctness, legibility, scanability, and
responsive behavior. The in-tree captures below were produced by the local
fixture workbench and preserved as evidence, not used as external inspiration:

- [desktop viewport](evidence/phase-01/evidence-desktop-viewport.jpg) and
  [mobile viewport](evidence/phase-01/evidence-mobile-viewport.jpg) establish
  the inspected frame sizes;
- [full desktop](evidence/phase-01/evidence-full.jpg) and
  [full mobile](evidence/phase-01/evidence-mobile.jpg) preserve the complete
  responsive evidence view;
- [hero](evidence/phase-01/evidence-hero.jpg) preserves the run identity and
  fixture-only boundary;
- [terminal](evidence/phase-01/evidence-terminal.jpg) preserves the typed
  outcome presentation;
- [timeline](evidence/phase-01/evidence-timeline.jpg) preserves the
  candidate-to-terminal trace presentation;
- [JSONL](evidence/phase-01/evidence-jsonl.jpg) preserves the raw sanitized
  evidence disclosure.

The delegated-routing lab also preserves its accepted local-fixture views:

- [desktop success](evidence/phase-03/browser/success-desktop.png) drove
  scanability of endpoint, address, cache, and terminal evidence;
- [mobile success](evidence/phase-03/browser/success-mobile.png) drove
  narrow-screen wrapping and terminal legibility;
- [rate-limit failover](evidence/phase-03/browser/rate-limit-failover.png)
  drove visibility of `Retry-After`, backoff, and endpoint order.

The matching
[accessibility tree](evidence/phase-03/browser/success-a11y.txt) and
[Fast 4G performance trace](evidence/phase-03/performance/delegated-load-fast4g.json.json.gz)
preserve the non-visual accessibility and load evidence behind those captures.

Later screenshots and profiles intentionally remain in ignored raw storage
because they may contain run-specific identifiers or local environment detail.
