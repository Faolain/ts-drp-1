# Phase 03 Review: Browser Delegated-Routing Lab

Phase 03 implements the lookup-only browser Routing V1 adapter and `/delegated`
workbench described by [slice 03](../slices/03-browser-delegated-routing.md).
`BrowserRouting` owns endpoint validation, ordered failover, bounded backoff,
cache policy, response limits, exact operational diagnostics, and browser
address filtering. Its public type has `canProvide: false` and no `provide`
method, so delegated publication is unavailable by construction.

## Dependency and adapter evidence

The adapter pins
`@helia/delegated-routing-v1-http-api-client@8.0.1`, released on 2026-06-12.
The current major, `9.0.0`, was released on 2026-07-02 and was only 18 days old
at the gate; the selected release was 38 days old and therefore clears the
30-day release-age policy without abandoning the actively maintained package.
The exact installed 8.0.1 source was indexed and inspected before implementation.

The maintained client remains the request builder and response parser. Its
`getPeers` and `getClosestPeers` paths log and suppress failures and use the
bare global `fetch`, while exposing neither fetch injection nor a response-byte
cap. The adapter therefore captures the client's diagnostic logger and treats
captured failures as endpoint failures. A module-wide serialized scope
temporarily interposes `fetch` only for the configured endpoint origin and path
prefix, restores it in `finally`, and passes unrelated requests to the original
fetch. Matching requests force omitted credentials, redirect rejection, and no
referrer, then apply both declared-length and streamed-body byte limits.

This interposition is adapter policy required by the installed dependency, not
a replacement Routing V1 parser. The adapter's `BrowserRoutingTrace` is
ephemeral per-instance operational state for the workbench; it does not create
a second durable experiment telemetry vocabulary beside `ProbeEvent`.

## Bounds and failure semantics

- Endpoint count, endpoint IDs, origins, protocols, URL components, results,
  addresses per result, response bytes, attempt timeouts, cache TTL, and
  backoff are validated and capped.
- Public endpoints require HTTPS, an explicit origin allowlist, the exact
  acknowledgement string, and an explicit endpoint URL. Loopback HTTP exists
  only for deterministic fixtures.
- Caller abort and a per-attempt timeout are composed for every request.
  Aborting during an in-flight request or a retry sleep records an exact
  `aborted` trace. Grok found the retry-sleep diagnostic gap; the implementation
  and a direct regression test now cover it.
- Numeric and HTTP-date `Retry-After` values are bounded to two seconds.
  HTTP-date evaluation uses the injected clock, closing Kimi's determinism
  observation.
- Empty and legacy 404 results are exact `empty` terminals and may be cached for
  the configured bounded TTL. Malformed, oversized, poisoned, rate-limited,
  timed-out, offline, and other failed responses remain distinguishable
  endpoint failures.
- The adapter honors a caller-owned parent deadline. Phase 08 must supply its
  registered eight-second composed endpoint budget rather than relying on the
  adapter's deliberately broader per-attempt maximum.

No public delegated endpoint was contacted. Ordinary tests use maintained-client
parsing over injected responses or the separate-origin loopback fixture.

## Browser and visual evidence

The fixture workbench exposes 15 selectable scenarios covering the complete
registered matrix: success, CORS, cache hit, disabled cache, timeout, caller
abort, empty, legacy 404, malformed, oversized, poisoned, stale refresh,
429/`Retry-After`, socket outage, and ordered failover. It renders raw and
accepted addresses, endpoint attempts, cache state, timing, exact terminal
state, and the structural publication absence.

The delegated suite defines 14 browser cases and passes all 42 combinations
across Chromium, Firefox, and WebKit. The full network-spike browser project,
including the Phase 00 evidence replay, passes 45/45. These tests remain a
dedicated phase gate instead of ordinary repository CI; all endpoints are
loopback and the public-mode test returns before constructing routing when its
acknowledgement is absent.

Chrome inspection found no console errors, warnings, or issues. The successful
query made exactly one request to the expected loopback fixture and no public
request. At a 390 px viewport, `scrollWidth` equaled `innerWidth` and the
terminal remained legible. Under Fast 4G emulation at 1440×900, the captured
load measured 838 ms LCP, 0.0111 CLS, and no identified rendering savings. The
durable evidence includes desktop, mobile, and rate-limit failover screenshots,
an accessibility tree, and the compressed performance trace.

A fresh unprimed screenshot critique returned `ACCEPT`. Its non-blocking notes
were a dense mobile hero, ambiguous cache wording, and lower-page desktop
balance. The cache badge now says `CACHE MISS` (or the exact alternate state),
and the mobile line height was relaxed; no visual blocker remains.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps:

- Grok session `019f7fa6-663f-7fb2-b828-1d230a1db46b`: final
  `VERDICT: ACCEPT` after the abort-during-backoff trace was fixed and its
  15-test regression passed.
- Kimi session `f5c95187-64b5-4067-8fb7-1e5fde52de5c`: `ACCEPT`.

Kimi's deterministic HTTP-date clock observation was also fixed after its
acceptance. Its remaining notes are explicit design boundaries: the
release-age-compliant 8.0.1 pin is intentional; the three-browser suite is a
dedicated local gate; parent campaigns own their shorter composed deadline;
and empty-result caching lasts only for the configured bounded TTL. The
cosmetic double `.json` in the performance-trace filename does not affect the
compressed artifact. No blocking finding remains.

## Verification

- Focused adapter regression: 15/15 tests passed with 91.81% statement,
  79.73% branch, and 82.05% function coverage.
- Compile-time negative test passed under package `tsc --noEmit`; adding
  `provide` would make its `@ts-expect-error` unused and fail typecheck.
- Browser bundle firewall passed under esbuild's browser platform with no
  Kad-DHT, TCP, Node-routing module, or Node builtin.
- Dedicated Playwright project: 45/45 passed across Chromium, Firefox, and
  WebKit.
- Vite production build: 294 modules, 273.07 kB JavaScript (85.97 kB gzip) and
  17.14 kB CSS (4.46 kB gzip).
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with the 71 pre-existing warnings and no
  errors.
- Final serial `CI=1 pnpm test --run --reporter=dot`: 87 files passed, 639
  tests passed, 2 skipped, and 91.20% statement coverage.
- `git diff --check`: passed.
- No public-network request was made.
