# Phase 06 — First-Party Overflow Discovery Walk

Date: 2026-07-22

Outcome: **NOT CONFIRMED — the production source entered the live closest-peers
path, but `NodeRouting.getClosestPeers` aborted at its built-in operation deadline
before yielding a candidate.**

This refines Phases 04 and 05 without changing either result. Phase 04 showed
that the static canonical bootstrappers advertise Relay v2 HOP but refuse
reservations. Phase 05 showed that named dynamic AutoTLS relays can grant
reservations. Phase 06 tested the missing link: whether DRP's own overflow
source discovers candidates through a fresh public Amino DHT closest-peers
walk in this setup and run.

## Production wiring exercised

A temporary TypeScript harness wired the real production classes together:

1. `createNodeRouting(...)` from `packages/routing-node/src/index.ts`, in public
   client mode, with all seven `OFFICIAL_AMINO_BOOTSTRAPPERS` configured;
2. `waitForRoutingTable(1, signal)` after an explicit successful connection to
   the first reachable configured bootstrap address;
3. `relayNamespaceCid("phase06-public-dht-walk").multihash.bytes` as the opaque
   relay query key; and
4. `new NodeRoutingClosestPeersSource(routing).getCandidates(queryKey, signal)`
   from `packages/relay-policy/src/index.ts`.

The adapter therefore entered `NodeRoutingClosestPeersSource`, delegated to
`NodeRouting.getClosestPeers`, and in turn invoked the production libp2p
`host.peerRouting.getClosestPeers` path. No alternate DHT walker, delegated
routing endpoint, static candidate injection, or source/test modification was
used.

The harness also contained a conditional second stage that would create a
separate ephemeral libp2p observer using the pinned stack and production
`Libp2pRelayClient` for Identify and, at most, one reservation. Because the
candidate collection rejected first, that observer was not instantiated and
neither inspection nor reservation was reached. The harness was removed after
the run.

## Live observations

Three bounded public runs were made:

| Run | Production result cap | Pre-walk state                          | Refresh             | Closest-peers result                                          |
| --- | --------------------: | --------------------------------------- | ------------------- | ------------------------------------------------------------- |
| 1   |                    12 | bootstrap wait succeeded; 4 connections | not requested       | `AbortError: The operation was aborted`; 0 candidates yielded |
| 2   |                     1 | bootstrap wait succeeded; 4 connections | not requested       | same abort; 0 candidates yielded                              |
| 3   |                     1 | bootstrap wait succeeded; 3 connections | completed in 2.7 ms | same abort; 0 candidates yielded                              |

Reducing the result cap to one did not change the outcome. Each successful
bootstrap wait proves that the Amino routing table contained at least one peer.
The explicit bootstrap connection took approximately 0.54–0.95 seconds across
the runs. On every attempt, the closest-peers operation reached
`NodeRouting`'s fixed 10-second operation guard and rejected before its buffered
peer array was returned. Failed operations are not appended to
`routing.measurements`, so the production telemetry contains no completed
`getClosestPeers` measurement or trustworthy request count for these attempts.
The evidence therefore does not establish that a closest-peers RPC completed on
the wire.

The third run's routing shutdown did not settle after the aborted query and the
temporary process was interrupted after more than 60 seconds of cleanup wait.
The first two runs exited after cleanup without manual interruption.

## Candidate and reservation summary

| Observation                                            |                          Count/result |
| ------------------------------------------------------ | ------------------------------------: |
| Candidates surfaced by `NodeRoutingClosestPeersSource` |                                     0 |
| Candidates inspected through Identify                  |                                     0 |
| HOP-advertising candidates observed                    |                                     0 |
| Browser-usable candidates observed                     |                                     0 |
| Bonus reservation                                      | Not attempted — no candidate surfaced |

These zeroes are a consequence of the failed closest-peers operation, not
evidence that the public DHT contained no relay candidates during the run.

## Conclusion

With the repository's current production setup, DRP successfully started its
Node Amino host, connected to the canonical bootstrap tier, and populated a
nonempty routing table. Its real `NodeRoutingClosestPeersSource` also entered the
intended public-DHT closest-peers path. However, it did **not** surface relay
candidates in any of the three attempts: the underlying production operation
aborted at the 10-second guard before `NodeRouting` released its buffered
results.

Accordingly, this run does **not** confirm the primary Phase 06 claim that DRP's
own overflow source completes the public DHT walk and surfaces candidates. It
also does not falsify the Phase 05 observation that dynamic, browser-usable HOP
relays exist and may grant reservations; candidate inspection never became
possible here. The honest Phase 06 result is a reproducible bounded discovery
failure at the production closest-peers deadline.

## Follow-up (first-party, root-caused): it is a DHT-config problem, not the mechanism

A second, temporary harness (removed after the run) isolated *why* by mirroring
DRP's public Amino query settings but relaxing the 10-second cap. Two runs, same
warmup (~30 s, routing table 5–6 peers), querying `peerRouting.getClosestPeers`
toward a relay-namespace key with a **60-second** deadline:

| DHT settings | Deadline | Walk result | Closest peers | HOP-advertising | Browser-usable |
| --- | --- | --- | --- | --- | --- |
| DRP public: `clientMode:true`, `alpha:1`, `disjointPaths:1` | 60 s | aborted (never converged) | **0** | 0 | 0 |
| libp2p defaults: `clientMode:false`, default `alpha`/`disjointPaths` | 60 s | **completed in ~29 s** | **20** | **17** | **16** |

So the closest-peers **mechanism works** — with standard libp2p query settings the
walk surfaces 20 peers, 17 advertising `/libp2p/circuit/relay/0.2.0/hop`, 16 with
browser-usable transports (`/tls/ws`, `/webtransport`, `/webrtc-direct`). What
fails is the walk **under DRP's deliberately conservative public DHT
configuration** (`createAminoHostExtensions`, `packages/routing-node/src/index.ts`):
`clientMode:true` + `alpha:1` + `disjointPaths:1` + a 24 h `querySelfInterval`
throttle the iterative query so hard that it yields **zero** candidates even at 6×
`NodeRouting`'s 10-second guard. Combined with that guard, DRP's node overflow
relay discovery does not surface candidates in practice.

This is an **actionable finding, not a code defect**: the overflow tier exists and
the DHT contains plenty of browser-usable HOP relays, but to make DRP's
`NodeRoutingClosestPeersSource` actually reach them, the public Amino query
settings (query concurrency `alpha`, `disjointPaths`, and likely `clientMode`) and
the fixed 10 s operation guard would need loosening for the relay-discovery query.
(This concerns the **node** overflow path; browsers discover relays via delegated
routing, a separate path.) Note the exact single knob was not isolated — three
conservative settings were relaxed together — but the contrast (0 vs 20) is
unambiguous, and isolating the dominant knob (`alpha`/`disjointPaths` query
concurrency is the likely driver) is a small follow-up.
