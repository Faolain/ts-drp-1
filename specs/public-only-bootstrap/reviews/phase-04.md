# Phase 04 Public Relay Hunt Report

Date: 2026-07-22  
Outcome: **No usable public browser relay found. Phase 3 was not run.**

This was a bounded ecosystem-availability check, not a DRP correctness test. A
qualifying node had to have all three properties at the same time: a
browser-reachable transport with a valid certificate, a stable Peer ID and
multiaddr, and an open Circuit Relay v2 HOP service that returned `STATUS=100`
to an arbitrary `RESERVE` request.

## Candidate results

| Candidate | Browser multiaddr tested | Transport/certificate | Live protocol result | Verdict |
| --- | --- | --- | --- | --- |
| `QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt` | `/dns/sg1.bootstrap.libp2p.io/tcp/443/wss/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt` | WSS; valid Let's Encrypt chain (`verify return code: 0`) | Connected, Identify advertised `/libp2p/circuit/relay/0.2.0/hop`, `RESERVE` returned `STATUS=200` on both runs | Reservation refused |
| `QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN` | `/dns/sv15.bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN` | WSS; valid Let's Encrypt chain (`verify return code: 0`) | Connected, advertised HOP, `RESERVE` returned `STATUS=200` on both runs | Reservation refused |
| `QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb` | `/dns/am6.bootstrap.libp2p.io/tcp/443/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb` | WSS; valid Let's Encrypt chain (`verify return code: 0`) | Connected, advertised HOP, `RESERVE` returned `STATUS=200` on both runs | Reservation refused |
| `QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa` | `/dns/ny5.bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa` | WSS; valid Let's Encrypt chain (`verify return code: 0`) | Connected, advertised HOP, `RESERVE` returned `STATUS=200` on both runs | Reservation refused |
| `16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK` | `/dns4/bootstrap1.topology.gg/tcp/443/wss/p2p/16Uiu2HAm4MeUv712cWmXpvGEZ1r1741YoWvsCcmptCza43b7opdK` | WSS endpoint presented a self-signed certificate (`verify return code: 18`) | libp2p WSS inspection returned `outcome="refused"`; no RESERVE was sent | Not browser-reachable with a valid certificate |
| `16Uiu2HAmGjAVQyzgTCumpB9TuojKT4LZTBC5HRiZyuwGG9VHodLC` | `/dns4/bootstrap2.topology.gg/tcp/443/wss/p2p/16Uiu2HAmGjAVQyzgTCumpB9TuojKT4LZTBC5HRiZyuwGG9VHodLC` | WSS endpoint presented a self-signed certificate (`verify return code: 18`) | libp2p WSS inspection returned `outcome="refused"`; no RESERVE was sent | Not browser-reachable with a valid certificate |

`STATUS=100` is Relay v2 `OK`; `STATUS=200` is
`RESERVATION_REFUSED`. Merely advertising the HOP protocol was not counted as a
successful reservation.

The public delegated-routing lookup additionally advertised WebTransport and
WebRTC Direct addresses for some of the `bootstrap.libp2p.io` identities. Those
are alternate transports to the same peer/HOP service, whose actual RESERVE
response over a browser-usable WSS connection was an explicit refusal. They do
not supply a different reservation-granting candidate.

## Discovery and probe method

Candidate discovery used the live DNSADDR records for
`_dnsaddr.bootstrap.libp2p.io` and its four leaf hosts, exact peer lookups at
`https://delegated-ipfs.dev/routing/v1/peers/<peer-id>`, and the two stable WSS
bootstrap addresses already configured in `packages/network/src/node.ts`.
Querying the delegated endpoint with an unknown Peer ID returned an empty 200
response; it did not enumerate arbitrary closest peers. Exact lookups returned
current address records for three of the four IPFS bootstrap identities, while
DNSADDR and live dialing supplied the evidence for the fourth.

A temporary TypeScript probe used the repository's installed libp2p 3.3.5,
`@libp2p/websockets` 10.1.16, `@libp2p/circuit-relay-v2` 4.2.8, Identify,
Noise, Yamux, and the production `Libp2pRelayClient`. For each candidate it:

1. dialed the exact WSS multiaddr;
2. checked Identify for `/libp2p/circuit/relay/0.2.0/hop`;
3. sent the real Relay v2 RESERVE frame through the production decoder; and
4. reported the returned status without coercing or substituting it.

Representative second-run timings for the four reachable nodes were 1,989 ms
(Singapore), 1,058 ms (Silicon Valley), 1,074 ms (Amsterdam), and 426 ms (New
York). All four returned status 200. The temporary probe was removed after the
run.

Commands used for the live checks included:

```bash
dig +short TXT _dnsaddr.bootstrap.libp2p.io
dig +short TXT _dnsaddr.<leaf>.bootstrap.libp2p.io
curl -H 'Accept: application/x-ndjson' \
  https://delegated-ipfs.dev/routing/v1/peers/<peer-id>
openssl s_client -connect <host>:443 -servername <host> -verify_return_error
pnpm --dir packages/network exec tsx scratch-public-relay-probe.ts
```

## Grid wiring finding

The signed configured-fallback concept exists, but it is not a serialized
`VITE_RELAY_MULTIADDR` path. `control_plane.relay_policy.sources` contains only
an enable toggle; the verified `configuredFallback` candidate source must be
injected through `DRPNetworkNodeDependencies`. The grid currently injects only
`BrowserRoutingClosestPeersSource`, populated from `VITE_ROUTING_ENDPOINTS` and
operator labels from `VITE_RELAY_OPERATOR_GROUPS`. Therefore a successful
static candidate would need a small, separate grid variant that injects a
signed `ConfiguredFallbackRelaySource`, or a delegated-routing response that
contains that relay. No such variant was added because no candidate passed the
reservation gate.

## Phase 3 disposition

The full public grid E2E was intentionally not run. Four candidates failed
requirement 2 (open reservation grant), and two failed requirement 1 (valid
browser TLS) before reservation. Wiring any of them would have produced a
known-red experiment and could not establish the requested fully public chain.

No DRP source or test was weakened or changed. The existing public-Nostr plus
local-relay Playwright configuration remains intact. This result is an
ecosystem-availability finding: within the timeboxed candidate set, no public,
browser-reachable Circuit Relay v2 node granted an arbitrary reservation. It is
not evidence of a DRP code defect.
