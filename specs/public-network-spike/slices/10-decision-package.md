# Phase 10: ADR, Security Analysis, and Follow-Up Plan

## Contract

Every issue acceptance criterion is mapped to durable evidence, an explicit
verdict, or a documented no-go reason. The decision does not overclaim what the
100-trial campaign can establish.

## API seam

No new runtime API. The decision package proposes the clean future config and
observability contract using the spike's proven single-owner seams.

## Runnable artifact

The sanitized report links its manifests, protocol matrix, relay measurements,
registry/anchor comparison, grid demonstration, failure campaign, security
analysis, threshold verdicts, and package/source ledger.

## Verification

- ADR compares Node publisher + browser delegated lookup, browser full-DHT
  participation, custom signed registry, libp2p Rendezvous implementation or
  sidecar, delegated closest-peer relay discovery, and retained DNSADDR
  fallback.
- Security/privacy covers namespace/membership/address leakage, malicious
  routing results, Sybil/eclipse, replay, quotas/admission, endpoint
  observation, telemetry retention, and authorization separation.
- Documentation states public routers/relays are best-effort with no SLA.
- A decision-question matrix answers every issue bullet: publisher ownership,
  browser-only recovery without DRP services, global/network/object discovery
  scope, admission model, endpoint/self-hosted policy, owned DNSADDR count,
  concurrent reservation/diversity requirement, required browsers/transports,
  supported/overflow relay policy, proof-of-work, self-hosted Someguy, and
  cold-start/recovery SLO. Each row has evidence, a verdict, or a reasoned
  deferral.
- Go/no-go table covers cold start, first DRP peer/mesh/object, reservation,
  direct WebRTC, and recovery thresholds.
- Follow-up production plan separates routing seeds, rendezvous, relay policy,
  optional local relay service, and observability. Because the project is
  greenfield, the eventual migration may replace old config directly; the
  fixed bootstrap/owned-relay capability still remains available as the
  fallback policy.
- Reconnect health is redesigned around typed control-plane status rather than
  exact bootstrap Peer IDs. This is explicitly a design-only production
  deliverable; the tested prototype is limited to the spike adapter.
- Production migration risk records the current open dial gater and requires
  adoption of the spike's single `AddressPolicy` owner rather than a parallel
  policy.
- Completion audit maps every issue checkbox and named injection/telemetry item
  to authoritative current evidence.
- Run the every-phase review and quality gate.

## Must stay green

The playable grid demonstration and original fixed-bootstrap grid suite both
pass in Chromium, Firefox, and WebKit.

## Feedback that changes this phase

Only contradictory measured evidence or a changed product requirement changes
the verdict; thresholds are not relaxed after observing results without a
visible amendment.
