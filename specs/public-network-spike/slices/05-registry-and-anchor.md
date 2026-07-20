# Phase 05: Two-Endpoint Registry and DHT-Anchor Comparison

## Contract

The spike can register, refresh, expire, and discover validated records through
at least two independently configured endpoints, and can compare that path with
a DHT anchor that advertises only itself.

## API seam

`RendezvousDirectory`, `RegistryServer`, `RegistryClient`, and
`DhtAnchorPublisher`/`DhtAnchorResolver`. `AdmissionPolicy` provides
runtime-selectable `open`, `invite`, and `allowlist` modes. Invite-token is the
safe default PoC configuration; open admission is an explicitly Sybil-unsafe
canary, not a predetermined architecture decision.
`proofOfWork` is a fourth experimental policy with a bounded, versioned
challenge and verifier; it is never enabled without explicit resource caps.

## Runnable artifact

Start two fixture registries and use `/rendezvous` to register/discover while
either endpoint is stopped. `/anchor` resolves the same namespace through the
local DHT/delegated fixture and shows what metadata each option exposes.

## Verification

- TTL refresh/expiry, monotonic sequence, endpoint failover, one/all endpoint
  outage, quotas, per-namespace/client rate limits, response limits, replay
  flood, forged/oversized records, clock skew, and Sybil-pressure tests.
- Deterministic versioned namespace CID and provider visibility/reprovide tests.
- Explicit test that an anchor cannot advertise a browser as provider.
- Measured registry-versus-anchor freshness, leakage, availability, and
  operator-dependency table.
- Admission comparison records registration cost/latency, rejection and abuse
  behavior under Sybil pressure, secret distribution/rotation burden, and
  operator dependency for the Phase 10 decision.
- Proof-of-work tests cover challenge replay/expiry, adaptive-difficulty bounds,
  browser CPU/time cost, server verification cost, and bypass attempts.
- Dedicated browser tests, screenshots, and screenshot-critique.
- Run the every-phase review and quality gate.

## Must stay green

Registry services are spike-local; fixed DRP bootstrap remains available.

## Feedback that changes this phase

Admission policy, desired namespace scope, or an operational requirement for
browser-only recovery with no DRP-operated service changes the comparison.
