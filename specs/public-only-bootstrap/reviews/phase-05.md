# Phase 05 — Overflow Relay Path Verification

Date: 2026-07-22
Outcome: **VERIFIED — browser-usable public Circuit Relay v2 nodes that grant
reservations to arbitrary peers do exist, and DRP's libp2p stack reserves against
them.** This refines, and does not contradict, Phase 04.

## Relationship to Phase 04

Phase 04 checked the **static, canonical** bootstrap nodes
(`*.bootstrap.libp2p.io`) and found they advertise Relay v2 HOP but return
`RESERVATION_REFUSED` (`STATUS=200`) to strangers. That still stands: the
canonical bootstrap tier is **discovery seeds, not a relay tier**.

Phase 05 checks the other, dynamic tier: relays discovered by walking the Amino
DHT (AutoRelay-style). The claim under test — from an independent peer report —
is that such a walk surfaces ephemeral **AutoTLS `*.libp2p.direct`** relays that
*do* grant reservations and expose *browser-usable* transports. Confirmed.

## Method

Targeted reservation probe (two named addresses from the peer's DHT-walk
snapshot — not a scan) using the repository's **pinned** libp2p stack: `libp2p`
3.3.5, `@libp2p/circuit-relay-v2` 4.2.8, `@libp2p/websockets` 10.1.16,
`@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`, `@libp2p/identify` — the
same `@libp2p/circuit-relay-v2` client that DRP's production `Libp2pRelayClient`
(`packages/relay-policy/src/libp2p-client.ts`) wraps, so the result reflects
DRP's transport behavior. A local node listened on `<relay>/p2p-circuit`; a
**granted** reservation surfaces as a `/p2p-circuit` multiaddr on the local node
(a refusal yields none). The temporary probe was removed after the run.

## Results

Both candidates granted a reservation on this run:

| Relay Peer ID | IP | Reservation | Browser-usable circuit transports observed |
| --- | --- | --- | --- |
| `12D3KooW9u3XuDTVj9c34HKj1hupy8HZa1HDYdRKxgCGMnxRxy9w` | 34.142.215.123 | **GRANTED** | `/tls/ws` (AutoTLS `libp2p.direct`, valid cert) |
| `12D3KooWQ3vujLkLQ6YeDQ6qbGHcPk1AXLgGFcYMoTJnTggGLHo4` | 45.146.62.248 | **GRANTED** | `/tls/ws`, `/webrtc-direct`, `/webtransport` |

Representative granted circuit address (relay 1):

```
/dns4/34-142-215-123.k51qzi5uqu5dg7nxjlf1iz92feda1gf9t22m8rf1fjocpyffizlsjf46yjlc4e.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooW9u3XuDTVj9c34HKj1hupy8HZa1HDYdRKxgCGMnxRxy9w/p2p-circuit/p2p/<self>
```

The `/tls/ws` (and, for relay 2, `/webrtc-direct` + `/webtransport`) circuit paths
are exactly the transports a browser can dial — so these satisfy all three
requirements from Phase 04 (browser-reachable valid-cert transport + open HOP that
grants a reservation + stable Peer ID) that the canonical bootstrap nodes did not.

## Scope and honesty

- **What was independently verified here:** the *reservation-grant* + *browser-usable
  transport* half, against known addresses, with DRP's own pinned libp2p deps.
- **What was not re-run here:** a fresh, first-party DHT random-walk *discovery* of
  such relays. The peer already demonstrated discovery via a Kubo AutoRelay walk;
  an automated re-run via a `codex` subagent was **blocked by that tool's
  cybersecurity safety filter** (a false positive on legitimate public-infra
  research), so it was not rebuilt. DRP's production overflow source,
  `NodeRoutingClosestPeersSource` (`packages/relay-policy/src/index.ts`,
  `routingSource: "public-dht"`), performs exactly this closest-peers DHT walk;
  Phase 06 could exercise it end to end if a first-party discovery trace is wanted.
- **Ephemerality:** these are a **dated snapshot**. Public AutoRelay relays churn,
  fill their reservation pools, and impose traffic/time limits. They must remain
  **overflow only** — never primary, never hardcoded — consistent with
  `relay-policy`'s overflow priority gated by an operator-diversity threshold.

## Conclusion

The `bootstrap → Amino DHT → discover Relay v2 → reserve` overflow path is real:
loss of operated relays degrades to a **best-effort** public relay rather than a
hard connectivity outage. It is the correct fallback tier and is what DRP already
models. It does **not** replace running ≥2 operated (or willing-partner) relays as
the dependable, operator-diverse connectivity floor; the IPFS bootstrappers remain
discovery seeds (Phase 04), and the completed `OFFICIAL_AMINO_BOOTSTRAPPERS` set
gives that discovery a larger population to walk.
