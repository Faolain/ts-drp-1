# Deploying the modular DRP network (and running a grid demo)

This guide explains what it takes to run DRP's **modular network architecture**
(PRD 001) in practice — from a one‑command local WebRTC demo to a real
shareable deployment — and answers the common questions: do I have to run my
own nodes, is there a reputation system, can I still run an all‑in‑one node,
and how does the peer‑to‑peer WebRTC actually work.

## The mental model

Before PRD 001, "the network" was two hard‑coded seed multiaddrs compiled into
`@ts-drp/network`: you deployed nothing and every peer dialed the same seeds.
That is a single point of failure and a single trust/scoring authority.

After PRD 001 there is **no built‑in network**. A peer must be *told* where to
find others. Deploying therefore means **you run the discovery + relay
infrastructure**, and clients (e.g. the grid web app) are configured to point at
it. The trade: you lose "zero infrastructure," you gain "survives loss or
compromise of any one operator, registry, router, relay, region, DNS provider or
anchor," and no fixed seed is privileged.

The pieces you can deploy:

| Piece | What it is | Package / artifact |
|---|---|---|
| **Rendezvous registry** | HTTP service where peers publish signed, expiring records and others discover them | `@ts-drp/rendezvous` (`service.ts`, a `node:http` server) |
| **Circuit Relay v2 relay** | Relays a first connection between two browsers and brokers the WebRTC hole‑punch | a `DRPNode` with `relay_service.enabled: true` |
| **Delegated routing endpoint** (optional) | Routing V1 endpoint that tells browsers which relays exist | any Routing V1 server; the demo co‑locates one with the registry |
| **Membership** | Who is allowed to join (invite token or allowlist) | `@ts-drp/membership` |
| **The client** | The grid web app (or your own app) | `examples/grid`, configured via `VITE_*` |

Clients — the people playing the grid — run **nothing**; browsers are pure
clients (they cannot host a DHT or a relay). You (the operator) run the
registries and relays.

---

## How browser‑to‑browser WebRTC actually works

Two **browsers** can never connect with zero infrastructure — this is a property
of browsers, not of DRP. A browser has no public IP, no listening socket, and no
way to exchange WebRTC SDP/ICE with a stranger. So a browser↔browser WebRTC
connection **always needs a broker for the initial signaling**. In libp2p that
broker is a **Circuit Relay v2 relay** together with **DCUtR** (Direct Connection
Upgrade through Relay):

1. Both browsers reserve a slot on a relay and get a `/p2p-circuit` address.
2. They reach each other **through** the relay first.
3. DCUtR runs over that relayed link to coordinate a **hole‑punch**.
4. If it succeeds → they hold a **direct WebRTC** connection and the relay leaves
   the data path. If the NAT/firewall is hostile → they stay relayed (the
   correct fallback — relayed beats disconnected).

So the relay is a **matchmaker and fallback, not a downgrade**: after the
upgrade your game traffic is direct WebRTC. "A relay is involved" is not the
same as "not WebRTC." The grid's E2E asserts exactly this
(`hasDirectWebRtc || hasRelayedPath`); in a permissive network it is direct
WebRTC, and it correctly stays relayed where hole‑punching cannot work
(including some headless CI environments).

> **What does NOT give you WebRTC:** the legacy *single fixed seed* setup. Phase 7
> removed the bootstrap's GossipSub privilege, so two browsers behind one seed no
> longer discover each other for a direct dial — they only sync because GossipSub
> gossip propagates *through* the seed's pub/sub. Their grid state converges, but
> there is no direct connection and no WebRTC. Use the modular path (below) for
> the peer‑to‑peer WebRTC experience.

---

## Tier 1 — One‑command local WebRTC demo

The fastest way to see it work, on one machine, with real WebRTC between two
browser windows:

```bash
pnpm install                      # once
pnpm --filter ts-drp-example-grid demo
```

This stands up, on a single host, the whole modular stack with **no fixed
bootstrap seeds**: two rendezvous registries + a delegated‑routing endpoint
(co‑located in one small server) and two operator‑diverse Circuit Relay v2
relays, then serves the grid in modular mode. When it prints the URL, open

```
http://127.0.0.1:4174
```

in **two** browser windows. Click **CREATE** in one, copy the grid id, paste it
into **GRID ID** in the other and click **JOIN**. Move with `W`/`A`/`S`/`D`. The
two peers discover each other through rendezvous, connect through a relay, and
upgrade to direct WebRTC where the environment allows. Ctrl+C stops everything.

This is exactly the stack the modular E2E (`pnpm e2e-test`) exercises, run
interactively. It uses local‑fixture allowances (loopback / plaintext WebSocket)
that are **demo‑only** and never emitted by a production config.

### Infra-independent discovery via Nostr

The Nostr profile replaces the HTTP registry with an open-admission Nostr
rendezvous transport while retaining local delegated routing and two
operator-diverse relays for browser connectivity:

```bash
pnpm --filter ts-drp-example-grid demo:public-infra
```

By default it starts the local Nostr fixture. To exercise best-effort public
discovery, override the relay list; the demo then drops the local Nostr fixture:

```bash
VITE_NOSTR_RELAYS="wss://relay.damus.io,wss://nos.lol" \
  pnpm --filter ts-drp-example-grid demo:public-infra
```

For a deployed grid, set the same variable during the build and omit the local
fixture processes. Live public operation is operator-gated and best-effort:
public relays are open-admission, untrusted transport, and DRP signatures are the
authority. Nostr supplies discovery, not connectivity; browsers still need a
real WebRTC/relay path.

This path is proven end to end: the `grid-public-infra` Playwright E2E has two
real browsers discover each other over Nostr (no HTTP registry) and converge grid
state, across **Chromium, Firefox, and WebKit**, both against the local fixture and
against **real public relays** (`relay.damus.io`, `nos.lol`):

```bash
# All three engines, local fixture:
GRID_E2E_BROWSERS=chromium,firefox,webkit \
  pnpm exec playwright test --config examples/grid/playwright.public-infra.config.ts

# Against real public relays (use a unique namespace to isolate the run):
VITE_NOSTR_RELAYS="wss://relay.damus.io,wss://nos.lol" \
  VITE_RENDEZVOUS_NAMESPACE="drp-network:v1:<unique-base64url>" \
  GRID_E2E_BROWSERS=chromium,firefox,webkit \
  pnpm exec playwright test --config examples/grid/playwright.public-infra.config.ts
```

#### The connectivity half: why you still operate a relay

Discovery runs on public infrastructure trivially because a Nostr relay is
open — anyone can post and read. The **connectivity** half (a Circuit Relay v2
node that brokers the browsers' first contact and WebRTC upgrade) is not so easy
to source publicly. A browser-usable public relay must, at the same time: (1)
expose a browser-reachable transport with a **valid** certificate
(`/wss`, `/webtransport`, or `/webrtc-direct`); (2) run an **open HOP** service
that actually **grants a reservation** to an arbitrary peer; and (3) have a
stable, known Peer ID.

A bounded survey (2026-07) found two distinct tiers:

| Candidate tier | Browser-reachable (valid cert)? | Grants reservation? |
| --- | --- | --- |
| The `*.bootstrap.libp2p.io` IPFS nodes (canonical/static) | Yes — valid Let's Encrypt WSS, advertise `/libp2p/circuit/relay/0.2.0/hop` | **No** — `RESERVE` returns `STATUS=200` (`RESERVATION_REFUSED`) to strangers |
| DHT-discovered **AutoTLS `*.libp2p.direct`** relays (dynamic) | Yes — AutoTLS-issued valid cert over `/tls/ws` (some also `/webrtc-direct`, `/webtransport`) | **Yes** — verified live reservations with DRP's pinned libp2p stack |

So the canonical IPFS bootstrap nodes are **discovery seeds, not relays** — they
advertise HOP but refuse reservations to strangers (a deliberate policy). But the
*dynamic* tier does exist: walking the Amino DHT (AutoRelay-style) surfaces
ephemeral AutoTLS relays that **do** grant browser-usable reservations. This is
exactly the shape of DRP's **overflow** relay tier (`NodeRoutingClosestPeersSource`,
`routingSource: "public-dht"`; browsers use delegated routing) — gated behind an
operator-diversity threshold. Evidence:
`specs/public-only-bootstrap/reviews/phase-04.md` (canonical refuse) and
`phase-05.md` (dynamic grant).

**Important — the DRP node overflow tier is not usable as-shipped** (see
`phase-06.md`). Two things stand in the way, both by design and both fixable:

- **DHT config throttle.** DRP's public Amino DHT settings
  (`createAminoHostExtensions`) set `alpha:1` + `disjointPaths:1` — single-path,
  one-at-a-time queries — so a relay-discovery closest-peers walk never converges
  within `NodeRouting`'s fixed 10 s guard (**0** candidates, even at a 60 s deadline).
  Relax those to libp2p defaults, keeping `clientMode:true` (verified: the same walk
  then finds ~20 peers / 17 HOP / 16 browser-usable in ~29 s). But that Amino config
  is shared with production rendezvous-anchor queries, so it is a resource tradeoff,
  not a free flip. And the walk takes ~29 s, so the 10 s operation guard also needs
  raising for discovery.
- **Unwired.** `NodeRoutingClosestPeersSource` is defined but not composed into any
  production relay policy yet.

So today the overflow tier is a **designed-but-not-enabled** capability. Regardless,
these dynamic relays are **ephemeral** (they churn, fill reservation pools, impose
limits) and **untrusted** (could be an attacker's node), so even once enabled they
are best-effort **overflow only**: run **≥2 relays you (or a willing partner)
operate** as the dependable, operator-diverse floor. (Routing that *finds* relays can
already use public delegated routing, e.g. `https://delegated-ipfs.dev/routing/v1/`.)

---

## Tier 2 — A real, shareable modular deployment

To let people on the internet play, the same pieces need **public** addresses.
Minimum viable:

1. **1–2 rendezvous registries** (`@ts-drp/rendezvous` service) behind HTTPS.
   Browsers require plaintext only for a loopback fixture; production must be
   HTTPS. Two independent registries give you the "survive one registry down"
   property; one is enough to function.
2. **1–2 relays** — `DRPNode`s with `relay_service.enabled`, reachable by
   browsers over **WSS/TLS** (browsers cannot use raw TCP or `webrtc-direct`
   listeners). Put them on different hosts/operators for operator diversity.
3. **Relay discovery** — how a browser finds the relays. Options, cheapest ops
   first:
   - **`registry_relay_records`** — relays publish themselves to the registry
     under `drp-relays:v1:<network>`; browsers read relays from the same registry
     they already use. No separate routing service.
   - **`configured_fallback`** — a signed relay list baked into the client config
     (the "owned relay floor"). No routing service, but you must sign the relay
     records.
   - **`delegated_closest_peers`** — a Routing V1 endpoint advertises the relays
     (what the demo uses). Needs a routing service.
4. **A membership invite** — the grid uses invite admission. An invite is a
   shared bearer token (≥16 chars, `InviteVerifier`). Put the same token on the
   registries (admission) and in the client (`VITE_MEMBERSHIP_INVITE`). For real
   deployments prefer per‑use or allowlist admission over a single shared secret.
5. **The grid, built as a static site**, pointed at your endpoints:

```bash
VITE_NETWORK_MODE=modular \
VITE_RENDEZVOUS_ENDPOINTS="https://reg-a.example/rz,https://reg-b.example/rz" \
VITE_ROUTING_ENDPOINTS="https://route-a.example/,https://route-b.example/" \
VITE_RELAY_OPERATOR_GROUPS="<relayPeerA>=op-a,<relayPeerB>=op-b" \
VITE_MEMBERSHIP_INVITE="<your-invite-token>" \
  pnpm --filter ts-drp-example-grid build
```

Users open the site and play. They run nothing; browsers cold‑start, discover a
peer through a registry, reserve a relay, connect, and upgrade to direct WebRTC
where the network permits.

The grid app config is assembled by `examples/grid/src/network-config.ts`
(`buildModularNetworkConfig`) from these `VITE_*` vars, and wired in
`examples/grid/src/index.ts` via `@ts-drp/rendezvous`, `@ts-drp/relay-policy`
and `@ts-drp/control-plane`.

---

## Tier 3 — Production resilience (operator‑gated, tracked as OPEN)

`PRD/002-phase-0-policy.md` marks the full production posture as the
operator‑gated deployment‑half that is **not done in code**: ≥3 independent
registry operators, ≥2 permitted delegated‑routing endpoints, operator‑diverse
owned relays in separate failure domains, the full Chromium/Firefox/WebKit +
Node‑publisher acceptance matrix, and public‑campaign sign‑off. That is what
makes the network survive losing any one operator — it needs real operations,
not more code. Public features stay disabled wherever campaign evidence is
insufficient.

---

## Can I still run an all‑in‑one node like before?

Yes — two ways, and one of them keeps WebRTC:

- **Legacy seed+relay (simple, no WebRTC between browsers).** Run one `DRPNode`
  with `seed: true` + `relay_service.enabled` (see `configs/network-spike-relay.json`)
  and point the app at it with `VITE_BOOTSTRAP_PEERS`. The app still supports
  this for a quick two‑window loop. Post‑Phase‑7, two browsers behind one seed
  sync **through** the seed's pub/sub rather than connecting directly — good for
  "quick and simple," not for showing off WebRTC.
- **Co‑located modular (all‑in‑one AND WebRTC).** Run the registry and a relay as
  two processes on **one** host (exactly what `pnpm --filter ts-drp-example-grid
  demo` does). Browsers discover via the registry, connect via the relay, and
  upgrade to direct WebRTC. This is "all‑in‑one" from an ops standpoint — one
  machine — while still giving the peer‑to‑peer experience. The only difference
  from "before" is you run *registry + relay* instead of *one privileged seed*.

---

## Reputation / GossipSub node scoring

There is **no persistent, global reputation system**, by design.

- **GossipSub v1.1 peer scoring** is **per‑session and ephemeral**: mesh time,
  first‑message delivery, invalid‑message and behaviour penalties, IP‑colocation
  (now configurable), and score thresholds (gossip / publish / graylist /
  accept‑PX). Nothing is remembered across restarts.
- **Phase 7** removed the old permanent "bootstrap = 1000" application score. In
  its place is an **optional, bounded, revocable, authenticated‑only** observed‑
  behaviour reward that only activates if you inject an
  `AuthenticatedPeerBehaviorProvider`. By default every peer's app‑score is 0 and
  the mesh relies purely on native v1.1 scoring.
- **Relay operator diversity** uses evidence‑derived `operatorGroup` (from
  verified evidence, never the advertisement) — that governs *relay selection*,
  not gossip reputation.
- **Membership** (invite / allowlist) decides *who is allowed in*; that is
  authorization, kept strictly separate from scoring (Invariant 1: routing and
  scoring never decide authorization).

A durable, cross‑session reputation system is not built; the observed‑behaviour
seam is where one could be added later.

---

## Do I need to run my own nodes?

- **To host a demo people can play:** yes — you run the registry(ies) + relay(s).
  That is the minimum "owned floor." There is no fixed *seed* in the old coupled
  sense, but you do host discovery + relay.
- **Players:** no — they just open the browser app.
- **Minimum for a working WebRTC demo:** one host running a registry + a relay
  (Tier 1 / co‑located modular).
