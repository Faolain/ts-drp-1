# Phase 08 — Is the alpha:1 relay-discovery throttle an artifact of DRP's cold `getClosestPeers` walk?

Empirical + code-audit follow-up to phase-06. Question under test: js-libp2p's NATIVE
circuit-relay-v2 discovery works differently from DRP's custom
`NodeRoutingClosestPeersSource` — it (1) harvests HOP-advertising peers from the
already-connected peer set (a registrar topology on
`/libp2p/circuit/relay/0.2.0/hop`, alpha-independent) and (2) only reaches for a
peer-routing random walk when the connected set is not enough. Does mechanism (1)
obtain reservations at DRP's `alpha:1, disjointPaths:1, clientMode:true` Amino
config — making the phase-06 cold-walk failure an artifact of DRP's approach rather
than a fundamental limit?

**Answer: YES — artifact.** Native discovery obtained a public-relay reservation in
**3.6 seconds** at DRP's exact `alpha:1 / disjointPaths:1 / clientMode:true` DHT
tuning, from the warm connected-peer set, on the first attempt. The alpha:1
throttle only starves *iterative DHT walks*; it does not throttle the
connected-peer harvest at all.

## 1. Config audit (read-only)

### Native circuit-relay discovery in DRP production: installed, armed, but unprovisioned

- `packages/network/src/node.ts:516` — the production host always installs the
  relay client transport with **zero options**:
  `transports: [circuitRelayTransport(), webRTC(), webSockets()]`.
- Installed `@libp2p/circuit-relay-v2` is **4.2.8** — this version has **no
  `discoverRelays` option** (the option existed in the 1.x/2.x line). Instead,
  desired reservation count = number of plain `/p2p-circuit` listen addresses:
  `transport/listener.js` `listen()` calls `reservationStore.reserveRelay()` per
  `/p2p-circuit` addr, and `reservation-store.js` `#checkReservationCount()` emits
  `relay:not-enough-relays` → `RelayDiscovery.startDiscovery()` until each pending
  reservation is satisfied.
- `packages/network/src/node.ts:494` — the default listen set is
  `["/p2p-circuit", "/webrtc"]`, so **native discovery IS armed in production**
  (one desired reservation) unless `listen_addresses` is overridden.
- However, in the *base* production host there is **no peer router** (no DHT
  service, no `peerRouters`), so native discovery's mechanism (2) — the
  `RandomWalk` that calls `peerRouting.getClosestPeers` (libp2p 3.3.5
  `dist/src/random-walk.js:89`) — has nothing to walk. Mechanism (1) can only
  harvest DRP-owned peers (bootstrap list + pubsub discovery), which serve HOP only
  when `relay_service.enabled` (`node.ts:436`, `circuitRelayServer`). Native
  discovery is thus effectively *unprovisioned* against the public network in the
  default deployment: enabled machinery, no public peers to harvest.

### The custom source and native discovery are both active, and disjoint

- The DRP relay-policy engine (`packages/network/src/node.ts:646`
  `_startRelayPolicy`) composes candidate sources (`configured-fallback`,
  `cached-successful-relays`, `registry-relay-records`, and overflow sources
  `delegated-closest-peers`, `node-closest-peers`, `dht-relay-providers`) into a
  `CompositeRelayCandidateSource` and reserves via DRP's own
  `Libp2pRelayClient` — a **parallel reservation path that never touches the
  native transport's reservation store or its discovery**.
- The node overflow tier is now wired (post-phase-06):
  `packages/node/src/runtime.ts:117-131` instantiates
  `NodeRoutingClosestPeersSource` (`packages/relay-policy/src/index.ts:201`) when
  `control_plane.relay_policy.sources.node_closest_peers.enabled === true`, with a
  raised 45 s closest-peers timeout (`runtime.ts:26,157`). It still does a **cold
  `getClosestPeers` walk** on the tuned Amino DHT — the exact mechanism phase-06
  measured at ~0 results under alpha:1.
- Net: DRP relies on its custom policy for relay acquisition; native discovery
  runs incidentally beside it and is never given public HOP peers to harvest.

### The Amino DHT tuning (used by both the custom walk and native mechanism 2)

`packages/routing-node/src/index.ts:727-760` `createAminoHostExtensions`:
- `alpha: 1`, `disjointPaths: 1` for `network: "public"` (lines 732-736),
  `clientMode: true` for `mode: "client"` (line 740), protocol `/ipfs/kad/1.0.0`
  (line 28), `allowQueryWithZeroPeers: true` (line 739),
  `querySelfInterval`/`initialQuerySelfInterval`: 24 h for public (743, 748).
- `packages/node/src/runtime.ts:133` builds production routing hosts with
  `createAminoHostExtensions({ mode: "client", network })` → defaults apply.
- Because `kadDHT` exposes `peerRoutingSymbol`, the amino DHT **auto-registers as
  the host's peer router** (libp2p 3.3.5 `dist/src/libp2p.js:153-155`), so on a
  routing-enabled node, native discovery's random walk would also run at alpha:1.

### Installed versions (node_modules/.pnpm)

| package | version |
| --- | --- |
| libp2p | 3.3.5 |
| @libp2p/circuit-relay-v2 | 4.2.8 |
| @libp2p/kad-dht | 16.3.4 |
| @libp2p/websockets | 10.1.16 |
| @libp2p/tcp | 11.0.23 |
| @libp2p/bootstrap | 12.0.26 |

## 2. Empirical test — native discovery on the live Amino DHT

Temporary harness (`packages/network-spike/scratch-native-relay-disc.mjs`, removed
after the runs) built strictly from the repo's pinned deps above: `tcp() +
webSockets() + circuitRelayTransport()`, noise/yamux, identify, ping,
`kadDHT({ protocol: "/ipfs/kad/1.0.0", clientMode: true, alpha, disjointPaths })`,
bootstrap with the canonical 6-identity Amino set
(`packages/routing-node/src/constants.ts` `OFFICIAL_AMINO_BOOTSTRAPPERS`),
`addresses.listen: ["/p2p-circuit"]` (= 1 desired native reservation),
allow-all dial gater. 90-second observation window per run, polling
`node.getMultiaddrs()` for granted `/p2p-circuit` reservations plus
`self:peer:update`.

Runs performed 2026-07-22 (UTC ~21:34-21:52), residential network, macOS.

| Run | DHT config | First reservation | Reservations in 90 s | Connections / RT size at first reservation | Relay browser-usable? |
| --- | --- | --- | --- | --- | --- |
| 1 | `alpha:1, disjointPaths:1, clientMode:true` (DRP public) | **3.6 s** | 1 relay (2 addrs: tcp + quic-v1; native target is 1) | 11 conns / RT 8 | No (relay `12D3KooWRSkt…` advertises only `/tcp/4001`, `/udp/4002/quic-v1`) |
| 2 | `alpha:3, disjointPaths:10` (defaults-like), `clientMode:true` | **4.8 s** | 1 relay (8 circuit addrs: tcp, quic-v1, webrtc-direct, webtransport, v4+v6; native target is 1) | 32 conns / RT 26 | Yes (relay `12D3KooWM7Jk…` advertises `/webrtc-direct/certhash/…` and `/webtransport/certhash/…`) |

Both runs acquired the reservation in under 5 seconds — i.e. **before any
iterative DHT walk could possibly complete** (phase-06 measured a full walk at
~29 s even at default concurrency). At first-reservation time the node had ~11
raw connections from bootstrap + DHT chatter; the HOP-topology harvest converted
one of those into a reservation immediately. The alpha delta (3.6 s vs 4.8 s) is
noise: discovery latency is dominated by bootstrap connect + identify, not by DHT
query concurrency.

Which relay is granted is whatever HOP-speaking peer happens to be in the warm
set first — run 1's relay was tcp/quic-only, run 2's happened to be
browser-usable (webrtc-direct). Phase-06's walk-based sample (16 of 20 walked
peers browser-usable) says browser-usable relays are abundant; a native
`discoveryFilter` or a policy-side transport check would be needed to *prefer*
them, since the native store takes the first grant.

### Harness deviations and hazards observed (honest notes)

- **`allowQueryWithZeroPeers` had to be `false` in the harness.** With DRP's
  production value (`true`), arming native discovery on a cold node busy-loops:
  `RandomWalk.startWalk()` (libp2p 3.3.5 `dist/src/random-walk.js`) is a
  `while (walkers > 0)` loop with no backoff; with an empty routing table and
  `allowQueryWithZeroPeers: true`, `getClosestPeers` resolves instantly-empty, so
  the loop spins in the microtask queue and **starves the event loop permanently**
  (observed twice: ~118% CPU, timers never fire, bootstrap dials never complete).
  With `false`, queries wait for the initial self-query instead of returning
  empty, and the same runs completed normally. This flag does not change query
  concurrency once the routing table is populated, so it does not affect the
  question under test — but it is a real interaction hazard for DRP: a
  routing-enabled production node (aminoDHT registered as peer router,
  `allowQueryWithZeroPeers: true` at `routing-node/src/index.ts:739`, default
  listen `/p2p-circuit`) arms exactly this combination at cold start.
- Native reservation target was 1 (one `/p2p-circuit` listen addr); this phase
  tests *whether* native discovery lands reservations at alpha:1, not how many.
- Two live runs (one per config), single machine/network; timings are
  order-of-magnitude evidence, not a latency benchmark.

## 3. Conclusion and implication for the fix

**The alpha:1 failure is an artifact of DRP's cold-`getClosestPeers` approach,
not a fundamental limit.** DRP's `NodeRoutingClosestPeersSource` funnels relay
discovery exclusively through an iterative DHT walk, the one code path the
conservative `alpha:1 / disjointPaths:1` tuning throttles below usability
(phase-06: 0 peers in 60 s). js-libp2p's native discovery reaches the same
public relays through the already-connected peer set — identify tells the
HOP topology about every warm peer — and that path is untouched by DHT query
concurrency: it produced a live public reservation in 3.6 s under DRP's exact
DHT config.

Implications for the node overflow tier:

1. **Use the warm peer set, not a dedicated tuned walk.** Either (a) let the
   native transport's discovery own overflow reservations (it is already
   installed and armed at `network/src/node.ts:516,494`; it needs only public
   peers in the connection set, which a routing-enabled node already has), or
   (b) keep the DRP policy engine authoritative but add a candidate source that
   harvests HOP-advertising peers from `peerStore`/current connections instead
   of — or ahead of — the cold `getClosestPeers` walk. (b) preserves DRP's
   operator-group / reservation-count policy, which the native store cannot
   express (it takes the first grant, browser-usable or not).
2. Raising `alpha`/`disjointPaths` is **not required** for relay overflow; the
   phase-06 recommendation to relax them matters only if the walk itself must
   stay the mechanism.
3. Before arming anything native on cold nodes, resolve the
   `allowQueryWithZeroPeers: true` + `RandomWalk` busy-loop hazard above (set it
   `false`, gate `/p2p-circuit` listening until the routing table is non-empty,
   or pin a fixed relay first).
