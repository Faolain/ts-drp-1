# Phase 01b Review: Injectable DRP Network Seam

Phase 01b implements the default-preserving production seam described by
[slice 01b](../slices/01b-injectable-network-seam.md). `DRPNode` now consumes
the authoritative structural network interface and accepts existing network
and reconnect owners. `DRPNetworkNode` accepts a host factory through a
production-owned builder while retaining its message queue, GossipSub,
scoring, subscriptions, and protocol handlers.

## Dependency evidence

The exact installed `libp2p@3.3.5` source was indexed in the isolated
`dep:libp2p@3.3.5:site` llm-tldr index (405 code units). The semantic lookup
resolved `createLibp2p`, `checkServiceDependencies`, `validateConfig`, and the
typed service map in the installed source. That evidence shaped the additive
`Libp2pOptions` extension contract rather than introducing a parallel host
abstraction.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps. Grok's first pass rejected the phase and drove these corrections:

- The one-host guard now latches the in-flight `createLibp2p` promise before
  any `await`, so overlapping builder calls cannot create two data planes.
  Failure cleanup waits for an in-flight host and stops it.
- Cleanup failure produces an `AggregateError` retaining the factory error as
  its cause and first error.
- Reserved core service names are excluded from the public extension type and
  checked again at runtime for dynamically keyed inputs.
- Conformance now observes real score mutation/removal, ordered direct and
  broadcast queue delivery, group membership in both lifecycle generations,
  post-restart traffic, production PubSub identity, host replacement, and
  stopped-host cleanup.
- The socket-free fake-network artifact invokes both captured handlers and
  proves `reconnect: false` creates no reconnect interval.

Final verdicts on the stable tree:

- Grok session `019f7f48-b8e5-7f71-893c-78b2778d2fc5`: `ACCEPT`.
- Kimi session `49c78b33-9837-4964-8d2b-e47561595a67`: `ACCEPT`.

No blocking or high finding remains. Both reviewers noted the pre-existing
absence of a class-wide concurrent `DRPNetworkNode.start()` guard; the
host-builder race introduced by this seam is independently closed and tested.

## Runnable evidence

- The socket-free `DRPNode` artifact uses a deterministic structural fake,
  exercises message and group handlers, preserves the same dependency through
  restart, and covers injected, disabled, mismatched, and default reconnect
  ownership.
- The shared real-host conformance run executes the default and injected
  builders through the same production data plane and compares their normalized
  traces.
- Focused Phase 01b regression: 8 files passed and 62 tests passed.

## Verification

- `@ts-drp/types`, `@ts-drp/network`, and `@ts-drp/node` builds passed.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 pre-existing warnings and no errors.
- Final serial `CI=1 pnpm test --run --reporter=dot`: 85 files passed, 614
  tests passed, 2 skipped, and 92.58% statement coverage.
- `git diff --check`: passed.
- No public-network request was made.
