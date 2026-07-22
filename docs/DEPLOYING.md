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
