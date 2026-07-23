# Issue #5 Acceptance and Evidence Audit

## Overall verdict

The local decision package is complete: the architecture shape, protocol
harnesses, signed rendezvous proof, end-to-end grid proof, failure campaign,
security analysis, and production follow-up plan are accepted. Issue #5 is not
ready to close because its mandatory measured public report is absent.

Production use of public routing or relay capacity is **no-go** on current
evidence. The required public campaign is `environment-blocked`, made zero
requests, and cannot satisfy any public observed-rate or diversity rule. This
is a reasoned decision outcome, not a successful public measurement.

## Deliverables

| Issue deliverable                                                                | Status                             | Authoritative evidence                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture decision comparing routing, rendezvous, relay, and fallback options | Complete                           | [Architecture decision](architecture-decision.md)                                                                                                     |
| Reproducible Node and browser harnesses with captured versions                   | Complete                           | `packages/network-spike/`, its package manifest/lockfile, routing tests, and [routing reviews](reviews/)                                              |
| Public relay report across browsers and two conditions                           | No-go: environment blocked         | [Blocked report](evidence/phase-09-environment-blocked.json) records missing consent, registries, second egress, zero requests, and zero observations |
| Signed short-TTL rendezvous proof or rejection                                   | Complete: proof accepted           | `packages/network-spike/src/record/`, `packages/network-spike/src/registry/`, their package tests, and [registry review](reviews/phase-05.md)         |
| Disconnected joiner without pre-shared Peer ID                                   | Complete in controlled fixtures    | `packages/network-spike/src/grid/`, grid package/browser tests, and [grid review](reviews/phase-07.md)                                                |
| Bounded failure injection                                                        | Complete in deterministic fixtures | `packages/network-spike/src/failure-campaign/`, its package tests, and [failure review](reviews/phase-08.md)                                          |
| Explicit go/no-go thresholds                                                     | Complete; public rows unresolved   | `packages/network-spike/src/contract.ts` and the table below                                                                                          |
| Security and privacy analysis                                                    | Complete                           | [Security and privacy analysis](security-privacy.md)                                                                                                  |
| Follow-up configuration plan                                                     | Complete                           | [Production plan](production-plan.md)                                                                                                                 |
| Public routers/relays documented as best-effort, no SLA                          | Complete                           | [Architecture decision](architecture-decision.md) and this [decision record](README.md)                                                               |
| Existing bootstrap/relay capability remains available                            | Complete                           | Production defaults remain intact; [production plan](production-plan.md) retains the capability                                                       |

## Go/no-go rules

Threshold definitions are executable in
`packages/network-spike/src/contract.ts`; this table records their current
decision, not a second source for calculating them.

| Decision                                     | Pre-registered gate                                                                                                        | Current verdict                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Node DHT cold bootstrap                      | Per real condition: 100 fresh identities, observed success at least 95%, p95 at most 30 s, Wilson 95% interval reported    | No-go for production public use: no public observations                           |
| Delegated first valid DRP peer               | Per browser/condition: 100 fresh identities, observed success at least 95%, p95 at most 20 s, Wilson 95% interval reported | No-go for production critical path: no public observations                        |
| GossipSub mesh and first synchronized object | Five controlled repetitions per browser, all pass, p95 at most 30 s                                                        | Go for the controlled architecture proof                                          |
| Public relay supported baseline              | Per browser/condition/profile: 50 identities, observed reservation success at least 95%, p95 at most 20 s                  | No-go: no public observations                                                     |
| Public relay optional overflow               | Same cells, observed success at least 50%, owned fallback begins within 5 s after exhaustion                               | Deferred/disabled: no public observations; deterministic fallback behavior passes |
| Public relay diversity                       | 600 browser identities and accepted reservations across at least two coarse operator groups                                | No-go for baseline: no observations or diversity evidence                         |
| Controlled direct WebRTC upgrade             | Five repetitions per browser, all pass within 20 s with correlated direct transport and bidirectional bytes                | Go for the controlled architecture proof                                          |
| Public direct WebRTC canary                  | One report-only canary per browser/condition                                                                               | Deferred: no public observations and no fleet SLO                                 |
| Relay/registry loss recovery                 | Every registered deterministic scenario reaches its expected state within 60 s                                             | Go for the controlled recovery design                                             |
| Total outage                                 | Typed terminal within 30 s with bounded work and cleanup                                                                   | Go; deterministic composed outage terminates at the registered boundary           |

## Decision questions

| Question                                  | Verdict                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher ownership                       | Node publishes itself through DHT; browser publishes signed records through DRP registries. No proxy provider spoofing.                                                                                                                                                                                    |
| Browser-only recovery with no DRP service | No-go. The selected design needs a DRP-operated registry, configured Node anchor, or owned seed.                                                                                                                                                                                                           |
| Discovery scope                           | Opaque per-network by default; per-object is opt-in for room isolation; global enumerable discovery is rejected.                                                                                                                                                                                           |
| Admission                                 | Invite token by default for the prototype, allowlist for closed deployments, open only as a canary, proof-of-work only as bounded defense in depth.                                                                                                                                                        |
| Endpoint and self-hosting policy          | No delegated endpoint is currently authorized. Production starts with an empty allowlist; each named endpoint requires operator, terms, privacy, and credential review plus bounded multi-endpoint failover. Self-hosted Routing V1 is deferred until governance, privacy, or SLO requirements justify it. |
| Owned DNSADDR count                       | Any migrated supported path must provision at least two owned seeds/relays under independently reviewed failure domains. The current fixed seeds preserve capability but do not establish that independence.                                                                                               |
| Reservation concurrency/diversity         | A baseline would require two concurrent reservations across at least two coarse operator groups. Coarse IP/ASN counts are mandatory reported evidence but have no separate frozen threshold. Current public evidence fails the operator gate and contains no IP/ASN observation.                           |
| Browsers/transports                       | Chromium, Firefox, and WebKit; WSS conservative profile plus an explicitly broader WebTransport/WebRTC Direct profile.                                                                                                                                                                                     |
| Public relay policy                       | Not baseline. Overflow remains disabled pending the public rule; owned fallback is supported.                                                                                                                                                                                                              |
| Proof-of-work                             | Not the default and not authorization; it only raises abuse cost.                                                                                                                                                                                                                                          |
| Self-hosted Someguy                       | Not required now; retain a configurable Routing V1 seam and reassess from endpoint policy.                                                                                                                                                                                                                 |
| Cold-start/recovery SLO                   | The controlled/owned path requires mesh and first sync within 30 s, direct upgrade within 20 s, recovery within 60 s, and a total-outage diagnostic within 30 s. Public features have no SLA; their eligibility gates remain the observed-rate/latency rules above.                                        |

## Failure-injection coverage

The table maps the issue's named injections to owner-driven deterministic
evidence in `packages/network-spike/src/failure-campaign/` and
`packages/network-spike/tests/failure-campaign.test.ts`.

| Required injection                                                                    | Evidence                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Delegated outage, DNS/CORS failure, 429, stale/poisoned/malformed/oversized responses | Delegated adapter scenarios with typed endpoint, backoff, and terminal outcomes |
| 50%, 75%, and 90% undialable candidates                                               | Seeded candidate populations with real attempt counts                           |
| All reservations refused                                                              | Decoded refusal sequence followed by owned fallback                             |
| Relay loss during signaling                                                           | Reservation-client loss rotates inside acquisition                              |
| Relay loss after reservation                                                          | Coordinator invokes policy replacement                                          |
| Relay loss after direct upgrade                                                       | Direct proof remains live while replacement completes                           |
| One registry unavailable                                                              | Replica failover and reconciliation                                             |
| All registries unavailable                                                            | Typed registry outage                                                           |
| Replayed, expired, oversized, forged records                                          | Record validator rejection scenarios                                            |
| Sybil-flooded registration                                                            | Bounded registry capacity and quota scenario                                    |
| Stale DNSADDR fallback                                                                | Typed exhausted/invalid fallback rather than success                            |
| All dependencies unavailable                                                          | One composed parent deadline, typed terminal, complete cleanup                  |

## Telemetry coverage

`ProbeEvent` in `packages/network-spike/src/probe/events.ts` is the intended
experiment vocabulary, but not every declared event is emitted by current
source. The gaps below remain production-observability requirements rather than
being hidden behind schema-only coverage.

| Required telemetry                                              | Current evidence / gap                                                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing source and query counts                                 | Query counts are emitted; routing source is preserved by adapter/candidate provenance but is not a field on every `routing-query` event. Production status must make the source explicit.     |
| Address families and successful-dial ratios                     | `AddressPolicy`, relay attempts, campaign aggregates                                                                                                                                          |
| Selected relay identity/address/operator diversity              | Raw local diagnostics plus aggregate-only durable diversity                                                                                                                                   |
| Reservation requested/accepted/refused/expired/renewed/replaced | Accept/refuse/replacement outcomes are emitted. A distinct requested state and source emissions for the declared expiry/refresh events remain observability gaps.                             |
| First reservation and first valid DRP peer                      | Relay and grid milestone events                                                                                                                                                               |
| GossipSub mesh and first synchronized object                    | Grid coordinator milestones and browser traces                                                                                                                                                |
| WebRTC upgrade time/rate and relayed/direct bytes               | Correlated grid direct proof provides controlled evidence; generic transport/ICE event declarations are not emitted and the public rate remains unmeasured.                                   |
| Registry freshness and validation failures                      | Validation failures and record timing are exercised; the declared `registry-freshness` event has no source emission and must be added before production observability can claim completeness. |
| Endpoint failure, rate-limit, and backoff                       | Delegated/registry attempt traces and public stop policies                                                                                                                                    |

## Package and source ledger

The retained evidence chain is intentionally split by decision surface:

- the [Phase 00 review](reviews/phase-00.md) freezes the evidence contract and
  manifest requirements;
- the [Node DHT review](reviews/phase-02.md), [delegated-routing review](reviews/phase-03.md),
  and [browser DHT feasibility review](reviews/phase-03b.md) record the protocol
  matrix and routing decisions;
- the [registry review](reviews/phase-05.md) covers signed-record and anchor
  evidence;
- the [relay review](reviews/phase-06.md) records reservation, diversity, and
  fallback measurements from controlled fixtures;
- the [grid review](reviews/phase-07.md) and [failure review](reviews/phase-08.md)
  cover end-to-end browser and fault evidence; and
- the [public-campaign review](reviews/phase-09.md) plus the
  [blocked report](evidence/phase-09-environment-blocked.json) record why no
  measured public report exists.

Exact resolved package versions belong to `pnpm-lock.yaml`, generated manifests,
and the individual review records rather than this narrative. The critical
source owners are:

- evidence rules and report validation:
  `packages/network-spike/src/contract.ts`,
  `packages/network-spike/src/schemas.ts`, and
  `packages/network-spike/src/evidence.ts`;
- Node/browser routing: `packages/network-spike/src/node-routing/`,
  `packages/network-spike/src/browser-routing/`, and
  `packages/network-spike/src/browser-dht/`;
- rendezvous and anchors: `packages/network-spike/src/record/` and
  `packages/network-spike/src/registry/`;
- relay policy: `packages/network-spike/src/relay/`;
- end-to-end proof and failure evidence:
  `packages/network-spike/src/grid/` and
  `packages/network-spike/src/failure-campaign/`;
- authorized campaign boundary:
  `packages/network-spike/src/campaign-plan.ts`,
  `packages/network-spike/src/public-campaign/`, and
  `.github/workflows/network-spike-public.yml`.

Every completed implementation-sized change through the decision package has a
retained Grok and Kimi disposition in [reviews](reviews/), including the
[Phase 10 decision-package review](reviews/phase-10.md).
