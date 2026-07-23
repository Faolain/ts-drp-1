# PRD 002 — Phase 0 Policy: Schema Freeze and Open Operator Decisions

| | |
|---|---|
| Status | Partial — schema decisions frozen; operator decisions OPEN |
| Parent | `PRD/001-modular-architecture.md` (Phase 0) |

Phase 0 has two halves. The schema half is frozen here and enforced by tests
in `@ts-drp/rendezvous` (the schema's owner since the Phase 1 promotion; the
spike consumes it from there). The operator/product half requires human
decisions and
the authorized public campaign; those items are listed as OPEN with their
deciding owner, and Phase 0 does not exit until they are closed.

## Frozen: record and namespace schema v1

- **Peer rendezvous namespace:** `drp-network:v1:<networkId>`. The spike's
  earlier `drp-rendezvous:v1:` form is retired; validation rejects it. No
  compatibility alias — the spike is the only writer.
- **Relay service namespace:** `drp-relays:v1:<networkId>`, same
  `[A-Za-z0-9_-]{22,86}` network-id rule. Relay availability never shares the
  peer-rendezvous namespace: it has different expiry, authorization, and
  refresh behavior.
- **Deterministic relay CID:** derived exactly like the peer namespace CID —
  raw-codec CID over the SHA-256 of the namespace string — but over the
  `drp-relays:v1:` form, so the two lookup keys can never collide.
- **Capability split:** the ambiguous `circuit-relay` capability is removed.
  Records declare `relay-client` (can consume relays) and/or
  `relay-hop-v2-service` (operates a Circuit Relay v2 HOP service) explicitly,
  alongside the existing `drp-gossipsub` and `webrtc`. Validation rejects
  records still carrying `circuit-relay`. The default capability-count limit
  equals the vocabulary size (4), so the full legal set is always expressible.
- **Golden vectors:** the CID derivations are pinned by hardcoded expected CID
  strings in the spike test suite (CIDv1, raw codec `0x55`, SHA-256) — a
  changed hash, codec, or CID version fails tests rather than silently forking
  the DHT keyspace. This supersedes the earlier `ts-drp-relays:v1:` sketch
  formula in the `PRD/README.md` architecture notes.
- **Intentionally unchanged:** the record `kind` string
  `ts-drp-rendezvous-record` keeps its name — the freeze covers namespace and
  capability vocabulary, not the envelope kind. The public-only experiment
  contract keeps its opaque colon-free identifiers per its own frozen spec;
  reconciling that path with the namespace form is Phase 3 integration work.

## OPEN: operator and product decisions

Each item blocks Phase 0 exit; none is decidable from the codebase.

| Decision | Owner | Notes |
|---|---|---|
| Network namespace scope (one network vs per-room ids) | Product | Determines what `<networkId>` identifies |
| Admission lifecycle | Product + security | PRD 001 mandates starting with invite or allowlist |
| Registry operator set (≥3, independent failure domains) | Ops | Separate operators, providers, domains/DNS, regions |
| Permitted delegated Routing V1 endpoints (≥2) | Ops + security | Current public-only contract permits exactly one |
| Owned fallback relay domains | Ops | Independent DNS failure domains |
| Supported browser transports | Engineering | WSS baseline; WebTransport/WebRTC-direct need validation |
| Privacy notice and telemetry retention | Security/privacy owners | Gate 5 of PRD 001 §5 |
| Authorized public campaign run | Ops + security | Separately reviewed ref; frozen thresholds; two registries, two egress conditions |

### Gate 7 implementation status

- **Code-half: DONE.** `examples/grid` now has a modular configuration seam and a
  local-fixture modular Playwright specification covering rendezvous, runtime
  routing, relay policy, and health recovery with no fixed bootstrap peers.
- **Deployment-half: OPEN.** Final acceptance still requires at least two
  independent registry operators, at least two permitted delegated endpoints,
  operator-diverse owned relays, the full browser/Node publisher deployment run,
  and authorized public-campaign sign-off against the OPEN decisions above.

## Migration and boundary notes

- **No live data migrates.** Any record or namespace minted under the spike's
  earlier `drp-rendezvous:v1:` / `circuit-relay` schema is invalid after the
  freeze — deliberate: the spike is the only writer and its records are
  short-lived. Production never shipped the legacy forms.
- **Membership dependency direction.** `@ts-drp/rendezvous` currently owns the
  dependency on `@ts-drp/membership` (registry admission consumes the
  verifiers, matching the promotion story). Phase 2 wires membership
  verification into connection authentication; at that point rendezvous should
  take an injected verifier interface so registry acceptance and DRP
  authorization stay separate owners (PRD 001, invariants 1 and 6).

## Consequences already encoded

- Downstream phases build against the frozen namespace/capability vocabulary;
  registry, relay, and record tooling in the spike is updated in the same
  change so no consumer of the legacy forms survives.
- The relay CID gives Phase 5 its DHT lookup key (`findProviders(relayCid)`)
  without any further schema change.
