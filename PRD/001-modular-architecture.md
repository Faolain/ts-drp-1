# PRD 001 — Modular Network Architecture: Phased Implementation

| | |
|---|---|
| Status | Draft |
| Related | `PRD/README.md` (architecture notes), `specs/done/public-network-spike/production-plan.md` (frozen follow-up plan) |
| Scope | Network control plane: bootstrap, discovery, rendezvous, relay, recovery |
| Out of scope | DRP data plane (objects, hash graph, conflict resolution, GossipSub message flow) — it is reused as-is and must keep working through every phase |

## 1. Background

The repository currently contains two architectures:

1. **Production** is a fixed-seed design where bootstrap, discovery, relay service, and reconnect are coupled:
   - Two fixed DNS multiaddrs are compiled into the network package (`packages/network/src/node.ts:49`).
   - The reconnect loop asks "am I still connected to one of the configured bootstrap Peer IDs?" and redials those exact addresses if not (`packages/interval-reconnect/src/index.ts:77`).
   - Bootstrap Peer IDs receive a permanent GossipSub application score of 1000, while IP-colocation weighting is disabled (`packages/network/src/node.ts:490`).
   - `bootstrap: true` both marks a node as a seed *and* turns on the Circuit Relay v2 server.

2. **The spike** (`@ts-drp/network-spike`, private) contains most of the right modular pieces — signed records, multi-registry reconciliation, Node DHT routing, browser delegated routing, relay candidate/reservation policy, address policy, and a prototype control-plane coordinator — but they are a laboratory package, not assembled into production.

This PRD turns the architecture described in `PRD/README.md` into a phased implementation: keep the existing DRP/GossipSub data plane, and surround it with multiple independent discovery and connectivity paths, each owned by a dedicated module.

## 2. Objective

The resilience rule for joining:

> Joining succeeds when **any** authorized rendezvous path returns a valid peer and **any** connectivity path can reach it.

The concrete, testable objective:

> The network survives loss or compromise of any **one** operator, registry, delegated router, relay, region, DNS provider, or Node anchor, while existing authenticated meshes remain operational during **total** control-plane outage.

### Non-goals

- Surviving simultaneous loss of every public routing network, every registry, every relay, and every out-of-band contact. A brand-new pure browser with only a namespace and no reachable rendezvous path cannot join; that is an information-theoretic limit, not an implementation failure.
- Registry consensus or federation. Records are signed, sequenced, and expiring; clients reconcile. Registration must never require a quorum — the goal is availability.
- Storing rapidly changing peer addresses on a blockchain. Chain integration is optional and limited to a trust root / operator directory (see §7).
- Browser DHT publication. It remains structurally unavailable; browsers read via delegated routing only.

## 3. Target architecture

```
                         Membership verifier
                                 │
Known namespace ──┬── Registry A/B/C ──┐
                  ├── Node DHT anchors ├── validated peer candidates
                  ├── cached peers ────┤
                  └── signed invite ───┘
                                      │
                           Connection coordinator
                        ┌──────────────┴──────────────┐
                     direct                 Relay A + Relay B
                        └──────────────┬──────────────┘
                               authenticated peers
                                      │
                            GossipSub + DRP objects
                                      │
                               direct WebRTC upgrade
```

### Module boundaries

| Package | Responsibility | Promoted from (spike seam) |
|---|---|---|
| `@ts-drp/network` | libp2p host, transports, GossipSub, DRP messages | existing production package |
| `@ts-drp/control-plane` | coordinator, typed health model, recovery policy | `src/public-only/` coordinator, failure-campaign health adapter |
| `@ts-drp/routing-node` | Amino DHT adapter (Node/Electron) | `src/node-routing/` |
| `@ts-drp/routing-browser` | delegated Routing V1 adapters, bounds, failover | `src/browser-routing/` |
| `@ts-drp/rendezvous` | signed records, backend interface, multi-backend reconciliation | `src/record/`, `src/registry/` |
| `@ts-drp/relay-policy` | candidate sourcing, reservation lifecycle, diversity | `src/relay/` |
| `@ts-drp/membership` | invite / certificate / allowlist verification | admission experiments in `src/record/`, `src/registry/` |
| registry service | separately deployable signed-record registry | `src/registry-cli.ts` fixture |
| relay service | separately deployable / opt-in Circuit Relay v2 server | currently coupled to `bootstrap: true` |

### Invariants (hold in every phase)

1. **Routing results never decide authorization.** Every discovery result — registry, DHT, delegated router, cache, invite — is an untrusted candidate until DRP membership and the libp2p connection are authenticated.
2. **Relay-server mode is not controlled by the bootstrap flag.** A peer can consume a relay without serving one, operate a relay without becoming an authority, and publish rendezvous presence without doing either.
3. **Every network operation has a deadline, retry cap, cancellation, terminal result, and cleanup.**
4. **One address-policy owner.** The same policy governs routing, rendezvous, relay, DNSADDR, and direct dials; unsafe addresses are rejected and DNS is rechecked at dial time.
5. **Two identities per installation.** A libp2p key (Peer ID / freshness proof) and a DRP membership credential (authorization) are related but separate; neither substitutes for the other.
6. **Registry acceptance ≠ DRP authorization.** Backend policies (auth, payment, PoW, rate limits) are admission mechanics of that backend only.

## 4. Phased implementation

Phases are sequenced so the system ships at every step. The fixed-bootstrap/owned-relay path remains a supported policy until Phase 6 completes, and both paths must pass the same data-plane conformance suite throughout.

### Phase 0 — Policy freeze and public-evidence campaign

*Design and measurement gate; no production code change.*

- Decide and record: namespace scope, admission lifecycle (start with invite or allowlist), registry operator set, permitted Routing V1 endpoints (≥2 for production browsers — the current public-only contract permits exactly one, which is fine for the bounded spike but not for production), owned fallback domains, supported browser transports, privacy notice, and retention policy.
- Run the authorized public campaign on a separately reviewed ref: two independent registries, two real egress conditions, frozen evaluation rules. Do not weaken thresholds after observing results.
- Define the relay namespace split now so record schemas don't churn later: peer rendezvous `drp-network:v1:<network>` vs relay service `drp-relays:v1:<network>`, with a deterministic relay CID.
- Split the ambiguous `"circuit-relay"` capability (`packages/network-spike/src/record/index.ts:12`) into `relay-client` and `relay-hop-v2-service` in the record schema.

**Exit:** policy document merged; campaign evidence evaluated against frozen rules; record/namespace schema v1 frozen.

### Phase 1 — Package extraction

*Promote the proven spike seams into the production module boundaries. No production behavior change; `@ts-drp/network-spike` stays as the lab.*

- Create `@ts-drp/rendezvous` from `src/record/` + `src/registry/` (signed `SignedDrpRecordV1`, backend interface, union/highest-sequence/reject-conflicts/expire reconciliation — the behavior already present at `packages/network-spike/src/registry/index.ts:635`).
- Create `@ts-drp/routing-node` (Amino DHT lookup/publication) and `@ts-drp/routing-browser` (delegated routing with bounds and failover). Node-only DHT dependencies must not appear in browser entry points or bundles.
- Create `@ts-drp/relay-policy` from `src/relay/` (candidate sources, HOP verification, reserve/refresh/replace lifecycle).
- Create `@ts-drp/membership` with the invite/allowlist verifiers; leave threshold certificates as an interface stub.
- Promote — do not duplicate — the authoritative seams: `DRPNetworkHostFactory`, `DRPNetworkHostPolicy`, `AddressPolicy`, `NodeRouting`, `BrowserRouting`, `RendezvousDirectory`, `RelayPolicy`. No compatibility aliases, no parallel retry/address abstractions.

**Exit:** packages build and are unit-tested with the spike's fixtures; production still runs the fixed-seed path unchanged; browser bundle audit shows no Node-only deps.

### Phase 2 — Configuration and identity ownership

*The one reviewed breaking change to `DRPNetworkNodeConfig`; every consumer moves in the same change.*

- Add a `control_plane` config section with distinct typed owners: `routing`, `rendezvous`, `relay_policy`, `address_policy`, `observability` (per the frozen production plan).
- Separate optional local relay-service capacity from relay-client policy; delete the overloaded meaning of `bootstrap: true`. Fixed bootstrap + owned relay remains expressible — as an explicit policy, not a default entanglement.
- Make production host construction use the single `AddressPolicy` owner for all dials; remove the allow-all default for the new control-plane mode.
- Introduce the membership credential in config (invite or allowlist admission first) and wire the verifier into connection authentication.
- Land the typed observability vocabulary: routing attempts/results, address admission, dial outcomes, rendezvous freshness, backoff/rate-limit state, reservation lifecycle, fallback, first authenticated peer, mesh/object readiness, direct-vs-relayed, recovery, terminal reason, cleanup. Raw Peer IDs, addresses, namespaces, and tokens go only to access-controlled short-retention diagnostics.

**Exit:** all `DRPNetworkNodeConfig` consumers compile against the new shape; old and new config paths pass the same data-plane conformance suite.

### Phase 3 — Runtime-specific routing

- Node/Electron: enable `@ts-drp/routing-node` — Amino DHT with multiple public bootstrap entries, provider lookup, and namespace-CID publication (the mechanism proven by `packages/network-spike/src/public-only/node-publisher.ts:63`).
- Browser: enable `@ts-drp/routing-browser` with **at least two** independently operated delegated-routing endpoints from the Phase 0 policy.
- Routing output feeds the candidate pipeline only; it never affects authorization (Invariant 1).

**Exit:** Node joins via DHT with registries disabled in a test environment; browser fails over between delegated endpoints; browser bundle still free of Node-only deps.

### Phase 4 — Rendezvous ensemble

*The browser-writable primary path plus independent secondary paths.*

- Deploy at least three registry backends in independent failure domains: separate operators, hosting providers, domains/DNS, regions, rate limits, and storage. No shared database.
- Client behavior: publish the signed record to every reachable backend (success = ≥1 accepts); query all reachable backends; union; keep highest valid signed sequence per Peer ID; reject equal-sequence conflicts; drop expired records; then apply membership and address policy.
- Node anchors: Node/Electron peers publish the namespace CID to the Amino DHT as a separately selectable secondary path; browsers reach it via delegated `findProviders`.
- Cached authenticated peers: after successful authentication, retain a bounded cache of signed peer records. Restart order: cached peers immediately → registries in parallel → DHT anchors where supported → authenticated GossipSub peer exchange.
- Signed invite bootstrap: an invite URL/QR may carry namespace, membership capability, short-lived signed contact records, and a registry endpoint catalog — the out-of-band path during a directory outage. Contacts must expire; no permanent private addressing.
- Backend diversity behind one interface: `RendezvousDirectory` composes `HttpRegistryDirectory`, `DhtProviderDirectory`, `CachedPeerDirectory`, `InviteDirectory`, and experimentally `NostrRelayDirectory` (see §7).

**Exit:** browser cold-start succeeds with any single registry down; recovery succeeds with all registries down (via cache or anchors or invite); TTL expiry and sequence-conflict rejection covered by tests against real backends.

### Phase 5 — Relay diversity and owned fallback

- Connection policy order: safe direct addresses → existing reservation → maintain **two** reservations from different operators/network groups → community/public relays as measured overflow → owned relays in independent failure domains → upgrade to direct WebRTC when possible.
- "Two owned relays" means different hosting providers, regions, preferably different autonomous networks, and separate DNS failure domains — not two processes.
- Candidate sources composed behind `RelayPolicy` (which validates, reserves, enforces diversity, refreshes, replaces — and does not care where candidates came from): registry relay records, DHT providers of the relay CID, delegated closest peers (opportunistic overflow only — the sources at `packages/network-spike/src/relay/index.ts:193`), cached successful relays, signed configured fallback.
- Reservation is the only truth: dial → Identify → confirm `/libp2p/circuit/relay/0.2.0/hop` → RESERVE → require STATUS:OK and live expiry → refresh before expiry → replace on refusal/disconnect.
- Public candidate sources ship disabled unless their Phase 0 public evidence passed. Owned DNSADDR relays remain the supported floor.
- Anti-fake-diversity: `operatorGroup` must derive from evidence (operator credential, approved community keys, ASN classification), never solely from the advertisement.

**Exit:** relay-loss triggers replacement with a different operator group within bounded time; browsers hold two reservations with distinct operator groups; kill switch disables each public source independently without disabling owned fallback.

### Phase 6 — Health-based recovery

*Replace "am I connected to bootstrap Peer X?" with typed health. This retires the exact-Peer-ID check in `packages/interval-reconnect/src/index.ts:77`.*

- Typed status model: authenticated-DRP-peer presence; object synchronization; rendezvous record freshness and replica availability; healthy-backend count; live reservation count; direct-vs-relayed traffic; mesh diversity; which recovery attempts already failed.
- One coordinator (`@ts-drp/control-plane`) consumes status and chooses bounded recovery:

  | Failure | Recovery |
  |---|---|
  | Registry A fails | Continue B/C; cool down A |
  | All registries fail | DHT anchors, cache, signed invite |
  | Delegated router fails | Alternate router or registry records |
  | Relay disconnects | Reserve with a different operator |
  | Direct connection fails | Continue relayed |
  | DHT unavailable | Registries remain primary |
  | One peer disappears | Sync from another authenticated peer |
  | Everything unavailable | Preserve local state; bounded retry schedule |

- A healthy authenticated peer or synchronized mesh stays healthy even if a seed disconnects; a connected seed proves nothing about rendezvous, reservation, or data-plane health.
- Recovery runs under one parent deadline with typed terminals and cleanup, verified under partitions, hostile inputs, and total outage.

**Exit:** mesh survives simulated total control-plane outage (registries + routers + one relay down) with no disconnect; recovery paths emit typed telemetry; interval-reconnect's bootstrap-identity logic is deleted, not shimmed.

### Phase 7 — Mesh de-privileging and rollout

- Revise GossipSub scoring: remove the permanent 1000 application score for bootstrap Peer IDs; reward observed valid behavior and diversity. Revisit disabled IP-colocation weighting (`packages/network/src/node.ts:490`).
- Maintain connections to several authenticated peers with operator, transport, and network diversity where possible; rely on GossipSub v1.1 scoring, outbound mesh quotas, opportunistic grafting, and peer exchange.
- Rollout by policy: begin with owned routing/rendezvous/relay; canary delegated lookup and public relay overflow independently; every component has a kill switch that cannot disable owned fallback.

**Exit:** release gates in §5 all pass — including the final grid-example acceptance gate (gate 7) on the deployed modular infrastructure; public features remain disabled wherever campaign coverage was partial, blocked, incomparable, rate-limited, or operator diversity insufficient.

## 5. Release gates

Gates 1–6 are carried verbatim from the frozen production plan; gate 7 is the final end-to-end acceptance added by this PRD. All gate Phase 7 completion:

1. Fixed-bootstrap/owned-relay path and the new path pass the same production data-plane conformance suite.
2. Chromium, Firefox, and WebKit pass disconnected-joiner, direct-upgrade, relay-loss, and fallback scenarios.
3. Node-only dependencies are absent from browser bundles.
4. Every network loop has a deadline, cap, abort, terminal, cleanup, and typed telemetry assertion.
5. Security and privacy owners approve endpoint policy, admission, retention, and incident response.
6. Public features stay disabled when campaign evidence is insufficient.
7. **Final acceptance: the grid example runs on the deployed modular infrastructure.** `examples/grid` runs against a real deployment of the Phase 3–6 stack — ≥2 independent registries, runtime-specific routing, operator-diverse relays, health-based recovery — with no fixed bootstrap seeds in its configuration. The scenario, extending the existing Playwright suite (`examples/grid/e2e/grid.spec.ts`) across Chromium, Firefox, and WebKit:
   - a Node/Electron publisher joins via DHT + registries, creates the grid, and publishes the namespace anchor (the flow proven by `packages/network-spike/src/public-only/node-publisher.ts`);
   - a fresh browser cold-starts through the rendezvous ensemble alone, authenticates membership, joins the grid, and converges with the publisher's state;
   - the browser upgrades to direct WebRTC where the environment permits, and continues relayed where it does not;
   - injected single-component failures — one registry down during cold-start, relay loss mid-session with operator-diverse replacement — do not lose grid state or leave the mesh disconnected;
   - the run emits the typed control-plane telemetry from Phase 2, with terminal states and cleanup asserted.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Fake relay/registry diversity (one operator, many Peer IDs) | Operator credentials + ASN evidence for `operatorGroup`; diversity measured across credentials and networks, not Peer IDs |
| Registry backends censor/lose/expire records at will | ≥3 independent backends; client-side reconciliation; client-enforced expiry; cached peers and invites as independent paths |
| Delegated-routing endpoint concentration | ≥2 permitted endpoints; registries remain the primary browser path; DHT anchors independent |
| Config migration breaks consumers | Single reviewed change, no adapter layer keeping the old combined "bootstrap" meaning alive; both paths conformance-tested |
| Residential Electron relays unusable by browsers (no WSS/TLS/port-forwarding) | Advertise only after external reachability + browser-transport validation; TCP-only relays serve Node clients only |
| High PoW admission conflicts with frequent short-TTL record refresh | PoW is one backend admission mode, never a global requirement; prefer invite/allowlist admission |

## 7. Optional and deferred tracks

Not on the critical path; each enters behind the existing abstractions.

- **Nostr as a rendezvous backend.** Closest external fit for signed, replaceable, browser-writable, expiring records (NIP-01/NIP-78 addressable events, advisory NIP-40 expiry — clients must enforce expiry themselves). Prototype as `NostrRelayDirectory` behind `RendezvousDirectory`; treat the Nostr key as transport identity only — the embedded record is still signed by the DRP identity. Would remove the need for a mandatory custom registry deployment.
- **Aleph Cloud POST messages** as an additional independent backend — requires a bounded interop/cost spike first. Aggregates are a poor fit for multi-writer discovery.
- **Waku** — only if censorship-resistant messaging is needed beyond discovery.
- **Community relay contribution (Electron/Node).** Separate signed `RelayAdvertisementV1` published to the registry ensemble under `drp-relays:v1:<network>` plus a DHT provider record for the relay CID; advertise only after proven external reachability; strict resource limits; explicit opt-in — installing the app must never silently make a user a bandwidth provider.
- **Threshold membership** (e.g. 2-of-3 administrators) and delegable invite capabilities with rotation/revocation, replacing any single master signing key.
- **On-chain trust root** — optional operator-key/membership directory only; never live addressing.
- **Self-hosted Routing V1 / Rendezvous sidecar** — deployment options, reconsidered only if owned endpoint policy or an explicit availability requirement justifies the operational surface.
