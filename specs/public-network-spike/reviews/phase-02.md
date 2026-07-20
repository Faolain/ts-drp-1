# Phase 02 Review: Node Amino DHT Harness

Phase 02 implements the private Node-only Amino DHT harness described by
[slice 02](../slices/02-node-amino-dht.md). `NodeRouting` owns bounded peer
lookup, closest-peer traversal, provider publication, reprovide cancellation,
routing-table status, and clean shutdown. It constructs its single libp2p host
through the Phase 01b production seam, so the existing DRP data plane remains
authoritative while TCP and the Amino DHT are additive spike-only capabilities.

## Dependency and runtime evidence

The harness pins `libp2p@3.3.5`, `@libp2p/kad-dht@16.3.4`,
`@libp2p/tcp@11.0.23`, `@libp2p/interface@3.2.5`,
`@libp2p/peer-id@6.0.12`, and `multiformats@14.0.0`. Current primary
documentation and the exact installed sources were inspected before the
adapter was written. The source trace established that
`kad-dht:query:send-query` fires before the network query is sent, allowing the
Phase 00 `RequestBudget` to stop an over-budget query instead of merely
reporting it afterward.

The local server is forced into DHT server mode without enabling production
bootstrap mode. Runtime protocol inspection proves that it exposes circuit
relay `stop`, not relay `hop`; therefore it does not inherit the production
bootstrap server's unlimited relay reservations. Public bootstrap discovery is
also disabled. The opt-in public CLI explicitly dials one of two official
DNSADDR bootstrap addresses under its shared deadline signal.

## Evidence and safety invariants

- AutoNAT is enabled independently of bootstrap-server mode. Reachability
  observations come from the host's verified address set and include address
  scopes plus dialability; DHT results never imply reachability.
- Identify protocols come directly from `host.getProtocols()`.
- Returned peer addresses are classified, capped at 16, truncated
  deterministically, and filtered by `AddressPolicy`.
- Operation count, DHT request count, result count, and wall-clock duration are
  bounded. The public CLI additionally requires the exact acknowledgement
  string, an output directory under the durable evidence root, 1–8 requests,
  and a 1–30,000 ms deadline.
- Public artifacts reuse the Phase 00 manifest parser, add a strict Phase 02
  evidence schema, use per-run salted pseudonyms, run redaction assessment
  before writing, and are committed atomically as a run-specific pair.
- Transport-byte counters are reported as unavailable because libp2p does not
  expose a stable public counter at this seam. Logical DHT bytes and query
  counts are recorded instead of fabricating transport measurements.

No public canary was run. Ordinary tests use only isolated fakes and loopback
hosts.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps. Grok's first pass rejected the phase and drove these corrections:

- Public canaries now produce durable, Phase 00-compatible sanitized manifest
  and evidence files rather than terminal-only output.
- DHT server mode is independent of production bootstrap/unlimited-relay mode.
- Host creation, explicit bootstrap dialing, routing-table bootstrap, and
  queries share the public deadline.
- AutoNAT verified-address observations and host-derived Identify protocols
  replaced hard-coded or DHT-derived claims.
- Peer addresses are truncated and filtered within bounds, with real
  `NodeRouting` tests covering 50%, 75%, and 90% unusable address sets.

Final verdicts on the stable tree:

- Grok session `019f7f80-b1ad-7c73-b82c-55fce6f8d0f0`: `ACCEPT`.
- Kimi session `6a04d56d-1c10-4afb-98b8-d2a6d03accee`: `ACCEPT`.

No blocking finding remains. Kimi recorded three informational limitations:
transport bytes are explicitly unavailable, the progress-event request budget
surfaces over-budget work as a query failure, and the public evidence schema
has one measurement slot of headroom. None weakens the registered Phase 02
claim.

## Runnable evidence

- `pnpm --filter @ts-drp/network-spike node-routing --fixture` proves local
  client/server routing, provider publication/discovery, reprovide
  cancellation, real AutoNAT/Identify observations, and cleanup with no public
  request.
- Focused Phase 02 regression: 5 files passed and 41 tests passed, including 10
  `NodeRouting` tests.
- Production-network regression: 5 files passed and 39 tests passed.
- The browser example build produced a 120.79 kB JavaScript bundle
  (34.39 kB gzip). Its metafile and the universal package bundle contain no
  `@libp2p/kad-dht`, `@libp2p/tcp`, Node built-ins, or Node-routing module.
- The fresh CPU profile is
  `CPU.20260720.083900.83700.0.001.cpuprofile`. Of the sampled stacks, 1,806
  were idle; the largest active entry was ESM source compilation at 45 samples.
  No routing hot loop or retained timer appeared, and the terminal resource
  sample reported zero active timers.

## Verification

- `@ts-drp/network-spike` typecheck and build passed.
- `examples/network-spike` typecheck and Vite production build passed.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 pre-existing warnings and no errors.
- Final serial `CI=1 pnpm test --run --reporter=dot`: 86 files passed, 624
  tests passed, 2 skipped, and 91.17% statement coverage.
- `git diff --check`: passed.
- No public-network request was made.
